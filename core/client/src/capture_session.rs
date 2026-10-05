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
    sessions: Mutex<Vec<Arc<CaptureSession>>>,
}

impl CaptureSessions {
    pub fn start(&self) -> Arc<CaptureSession> {
        let mut sessions = self.sessions.lock().unwrap();
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
        session
    }

    /// Signal every outstanding worker before waiting for any of them.
    pub fn request_stop(&self) -> Vec<Arc<CaptureSession>> {
        let sessions = self.sessions.lock().unwrap();
        for session in sessions.iter() {
            session.stop_requested.store(true, Ordering::SeqCst);
            session.running.store(false, Ordering::SeqCst);
        }
        sessions.clone()
    }

    /// Return whether this was the latest worker, for lifecycle UI events.
    pub fn finish(&self, session: &Arc<CaptureSession>, result: Result<(), String>) -> bool {
        let mut sessions = self.sessions.lock().unwrap();
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
        !self.sessions.lock().unwrap().is_empty()
    }

    pub fn is_running(&self) -> bool {
        self.sessions
            .lock()
            .unwrap()
            .iter()
            .any(|session| session.running.load(Ordering::SeqCst))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;

    #[test]
    fn finishing_previous_capture_does_not_erase_new_stop_handle() {
        let sessions = CaptureSessions::default();
        let old = sessions.start();
        let current = sessions.start();
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
        let old = sessions.start();
        let current = sessions.start();
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
        let session = sessions.start();
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
        let old = sessions.start();
        sessions.request_stop();
        let current = sessions.start();
        sessions.finish(&old, Ok(()));
        assert!(current.running.load(Ordering::SeqCst));
        assert_eq!(old.wait(), Ok(()));
    }

    #[test]
    fn failed_start_with_no_live_resources_does_not_poison_future_stops() {
        let sessions = CaptureSessions::default();
        let session = sessions.start();
        sessions.finish(&session, Err("SFU unavailable".to_string()));
        assert_eq!(session.wait(), Ok(()));
        assert!(sessions.request_stop().is_empty());
    }

    #[test]
    fn health_stays_active_during_startup_and_pending_cleanup() {
        let sessions = CaptureSessions::default();
        let session = sessions.start();
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
        let session = sessions.start();
        session.publisher_stopped.store(false, Ordering::SeqCst);
        sessions.finish(&session, Err("SFU room close failed".to_string()));
        let retry = sessions.request_stop();
        assert_eq!(retry.len(), 1);
        assert_eq!(retry[0].wait(), Err("SFU room close failed".to_string()));
    }
}
