//! Ownership and completion of native video capture sessions.
//!
//! A replacement may begin while the previous worker is still shutting down.
//! Keep every worker reachable until it has released capture and its SFU room;
//! an old worker must never erase the replacement's stop handle.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::Duration;

pub struct CaptureSession {
    pub running: Arc<AtomicBool>,
    pub publisher_stopped: Arc<AtomicBool>,
    pub capture_stopped: Arc<AtomicBool>,
    stop_requested: AtomicBool,
    completed: Mutex<Option<Result<(), String>>>,
    completion: Condvar,
}

impl CaptureSession {
    pub fn cleanup_confirmed(&self) -> bool {
        self.publisher_stopped.load(Ordering::SeqCst) && self.capture_stopped.load(Ordering::SeqCst)
    }

    pub fn stop_requested(&self) -> bool {
        self.stop_requested.load(Ordering::SeqCst)
    }

    pub fn wait(&self) -> Result<(), String> {
        let completed = self.completed.lock().unwrap();
        let (completed, _) = self
            .completion
            .wait_timeout_while(completed, Duration::from_secs(15), |result| {
                result.is_none()
            })
            .unwrap();
        completed.clone().unwrap_or_else(|| {
            Err(
                "Native capture shutdown is still pending; sharing has not been confirmed stopped"
                    .to_string(),
            )
        })
    }
}

#[derive(Default)]
pub struct CaptureSessions {
    state: Mutex<CaptureSessionsState>,
}

#[derive(Default)]
struct CaptureSessionsState {
    sessions: Vec<Arc<CaptureSession>>,
    shutting_down: bool,
}

impl CaptureSessions {
    pub fn start(&self) -> Result<Arc<CaptureSession>, String> {
        let mut state = self.state.lock().unwrap();
        if state.shutting_down {
            return Err("Screen sharing cannot start while Echo is exiting".to_string());
        }
        let sessions = &mut state.sessions;
        for session in sessions.iter() {
            session.stop_requested.store(true, Ordering::SeqCst);
            session.running.store(false, Ordering::SeqCst);
        }
        let session = Arc::new(CaptureSession {
            running: Arc::new(AtomicBool::new(true)),
            publisher_stopped: Arc::new(AtomicBool::new(true)),
            capture_stopped: Arc::new(AtomicBool::new(true)),
            stop_requested: AtomicBool::new(false),
            completed: Mutex::new(None),
            completion: Condvar::new(),
        });
        sessions.push(session.clone());
        Ok(session)
    }

    /// Signal every outstanding worker before waiting for any of them.
    pub fn request_stop(&self) -> Vec<Arc<CaptureSession>> {
        let state = self.state.lock().unwrap();
        for session in state.sessions.iter() {
            session.stop_requested.store(true, Ordering::SeqCst);
            session.running.store(false, Ordering::SeqCst);
        }
        state.sessions.clone()
    }

    /// Permanently close admission and cancel existing sessions in one critical
    /// section. A queued Start must not revive capture while app exit waits for
    /// unrelated cleanup. Ordinary End Sharing uses request_stop instead.
    pub fn shutdown(&self) {
        let mut state = self.state.lock().unwrap();
        state.shutting_down = true;
        for session in state.sessions.iter() {
            session.stop_requested.store(true, Ordering::SeqCst);
            session.running.store(false, Ordering::SeqCst);
        }
    }

    /// Return whether this was the latest worker, for lifecycle UI events.
    pub fn finish(&self, session: &Arc<CaptureSession>, result: Result<(), String>) -> bool {
        let mut state = self.state.lock().unwrap();
        let sessions = &mut state.sessions;
        let latest = sessions
            .last()
            .is_some_and(|last| Arc::ptr_eq(last, session));
        session.running.store(false, Ordering::SeqCst);
        let succeeded = session.cleanup_confirmed();
        *session.completed.lock().unwrap() = Some(if succeeded {
            Ok(())
        } else {
            result.and(Err("Native capture cleanup is unconfirmed".to_string()))
        });
        session.completion.notify_all();
        // A failed teardown must stay visible to later Stop attempts. Never
        // turn an unconfirmed SFU disconnect into a false successful no-op.
        if succeeded {
            sessions.retain(|active| !Arc::ptr_eq(active, session));
        }
        latest
    }

    /// Includes startup and canceled workers whose cleanup is still pending.
    pub fn has_pending_capture(&self) -> bool {
        !self.state.lock().unwrap().sessions.is_empty()
    }

    pub fn is_running(&self) -> bool {
        self.state
            .lock()
            .unwrap()
            .sessions
            .iter()
            .any(|session| session.running.load(Ordering::SeqCst))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;

    #[test]
    fn shutdown_rejects_queued_start_even_after_existing_capture_finishes() {
        let sessions = CaptureSessions::default();
        let active = sessions.start().unwrap();
        active.publisher_stopped.store(false, Ordering::SeqCst);
        active.capture_stopped.store(false, Ordering::SeqCst);

        sessions.shutdown();
        assert!(active.stop_requested());
        assert!(!active.running.load(Ordering::SeqCst));
        assert!(sessions.start().is_err());
        assert!(sessions.has_pending_capture());

        active.publisher_stopped.store(true, Ordering::SeqCst);
        active.capture_stopped.store(true, Ordering::SeqCst);
        sessions.finish(&active, Ok(()));
        assert_eq!(active.wait(), Ok(()));
        assert!(!sessions.has_pending_capture());
        // Neither cleanup nor a repeated exit request may reopen admission.
        sessions.shutdown();
        assert!(sessions.start().is_err());
        assert!(!sessions.is_running());
    }

    #[test]
    fn shutdown_before_first_start_never_admits_capture() {
        let sessions = CaptureSessions::default();
        sessions.shutdown();
        assert!(sessions.start().is_err());
        assert!(!sessions.has_pending_capture());
        assert!(!sessions.is_running());
    }

    #[test]
    fn ordinary_stop_still_allows_a_new_share() {
        let sessions = CaptureSessions::default();
        let previous = sessions.start().unwrap();
        sessions.request_stop();
        assert!(!previous.running.load(Ordering::SeqCst));
        sessions.finish(&previous, Ok(()));

        let next = sessions.start().expect("End Sharing must allow sharing again");
        assert!(next.running.load(Ordering::SeqCst));
        assert!(!next.stop_requested());
    }

    #[test]
    fn finishing_previous_capture_does_not_erase_new_stop_handle() {
        let sessions = CaptureSessions::default();
        let old = sessions.start().unwrap();
        let current = sessions.start().unwrap();
        assert!(!old.running.load(Ordering::SeqCst));
        assert!(!sessions.finish(&old, Ok(())));
        assert!(sessions.is_running());
        let stopping = sessions.request_stop();
        assert_eq!(stopping.len(), 1);
        assert!(Arc::ptr_eq(&stopping[0], &current));
        assert!(!current.running.load(Ordering::SeqCst));
    }

    #[test]
    fn stop_keeps_replaced_workers_reachable_until_they_finish() {
        let sessions = CaptureSessions::default();
        let old = sessions.start().unwrap();
        let current = sessions.start().unwrap();
        let stopping = sessions.request_stop();
        assert_eq!(stopping.len(), 2);
        assert!(!old.running.load(Ordering::SeqCst));
        assert!(!current.running.load(Ordering::SeqCst));
        assert!(sessions.finish(&current, Ok(())));
        assert_eq!(sessions.request_stop().len(), 1);
        sessions.finish(&old, Ok(()));
        assert!(sessions.request_stop().is_empty());
    }

    #[test]
    fn stop_waits_for_cleanup_and_reports_its_error() {
        let sessions = Arc::new(CaptureSessions::default());
        let session = sessions.start().unwrap();
        sessions.request_stop();
        session.publisher_stopped.store(false, Ordering::SeqCst);
        let worker = session.clone();
        let (tx, rx) = mpsc::channel();
        let waiter = std::thread::spawn(move || tx.send(worker.wait()).unwrap());
        assert!(rx.recv_timeout(Duration::from_millis(20)).is_err());
        sessions.finish(&session, Err("SFU room close failed".to_string()));
        assert_eq!(rx.recv().unwrap(), Err("SFU room close failed".to_string()));
        waiter.join().unwrap();
    }

    #[test]
    fn late_completion_cannot_cancel_a_new_start_after_stop() {
        let sessions = CaptureSessions::default();
        let old = sessions.start().unwrap();
        sessions.request_stop();
        let current = sessions.start().unwrap();
        sessions.finish(&old, Ok(()));
        assert!(current.running.load(Ordering::SeqCst));
        assert_eq!(old.wait(), Ok(()));
    }

    #[test]
    fn failed_start_with_no_live_resources_does_not_poison_future_stops() {
        let sessions = CaptureSessions::default();
        let session = sessions.start().unwrap();
        sessions.finish(&session, Err("SFU unavailable".to_string()));
        assert_eq!(session.wait(), Ok(()));
        assert!(sessions.request_stop().is_empty());
    }

    #[test]
    fn health_stays_active_during_startup_and_pending_cleanup() {
        let sessions = CaptureSessions::default();
        let session = sessions.start().unwrap();
        assert!(sessions.has_pending_capture());
        sessions.request_stop();
        assert!(!sessions.is_running());
        assert!(sessions.has_pending_capture());
        sessions.finish(&session, Ok(()));
        assert!(!sessions.has_pending_capture());
    }

    #[test]
    fn unconfirmed_teardown_stays_visible_to_repeated_stops() {
        let sessions = CaptureSessions::default();
        let session = sessions.start().unwrap();
        session.publisher_stopped.store(false, Ordering::SeqCst);
        sessions.finish(&session, Err("SFU room close failed".to_string()));
        let retry = sessions.request_stop();
        assert_eq!(retry.len(), 1);
        assert_eq!(retry[0].wait(), Err("SFU room close failed".to_string()));
    }
}
