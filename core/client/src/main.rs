use eframe::egui;
use libwebrtc::{
    audio_frame::AudioFrame,
    audio_source::{native::NativeAudioSource, AudioSourceOptions, RtcAudioSource},
    video_frame::{I420Buffer, VideoFrame, VideoRotation},
    video_source::{native::NativeVideoSource, RtcVideoSource, VideoResolution},
};
use livekit::{options::TrackPublishOptions, prelude::*};
use serde::{Deserialize, Serialize};
use std::{
    borrow::Cow,
    f32::consts::PI,
    sync::mpsc::{self, Receiver, Sender},
    time::Duration,
};

#[derive(Default)]
struct CoreApp {
    control_url: String,
    sfu_url: String,
    room: String,
    identity: String,
    name: String,
    admin_password: String,
    status: String,
    token_preview: String,
    token: String,
    status_rx: Option<Receiver<String>>,
    connecting: bool,
    publish_test_media: bool,
}

impl CoreApp {
    fn drain_status(&mut self) {
        if let Some(rx) = &self.status_rx {
            while let Ok(msg) = rx.try_recv() {
                self.status = msg;
            }
        }
    }
}

impl eframe::App for CoreApp {
    fn update(&mut self, ctx: &egui::Context, _frame: &mut eframe::Frame) {
        self.drain_status();

        egui::CentralPanel::default().show(ctx, |ui| {
            ui.heading("Echo Chamber Core");
            ui.label("Native client scaffold (token + LiveKit connect)");
            ui.add_space(12.0);

            ui.horizontal(|ui| {
                ui.label("Control URL");
                ui.text_edit_singleline(&mut self.control_url);
            });
            ui.horizontal(|ui| {
                ui.label("SFU URL");
                ui.text_edit_singleline(&mut self.sfu_url);
            });
            ui.horizontal(|ui| {
                ui.label("Room");
                ui.text_edit_singleline(&mut self.room);
            });
            ui.horizontal(|ui| {
                ui.label("Identity");
                ui.text_edit_singleline(&mut self.identity);
            });
            ui.horizontal(|ui| {
                ui.label("Name");
                ui.text_edit_singleline(&mut self.name);
            });
            ui.horizontal(|ui| {
                ui.label("Admin Password");
                ui.add(egui::TextEdit::singleline(&mut self.admin_password).password(true));
            });

            ui.add_space(8.0);
            ui.checkbox(&mut self.publish_test_media, "Publish test audio/video");
            if ui.button("Fetch Token (Admin)").clicked() {
                self.status = "Requesting token...".to_string();
                self.token_preview.clear();
                match fetch_token(&self.control_url, &self.admin_password, &self.room, &self.identity, &self.name) {
                    Ok(token) => {
                        self.token = token.clone();
                        let preview = if token.len() > 24 { format!("{}...", &token[..24]) } else { token.clone() };
                        self.token_preview = preview;
                        self.status = "Token received.".to_string();
                    }
                    Err(err) => {
                        self.status = format!("Token error: {}", err);
                    }
                }
            }

            if ui.button("Connect to SFU").clicked() {
                if self.token.is_empty() {
                    self.status = "Fetch token first.".to_string();
                } else if self.connecting {
                    self.status = "Already connecting/connected.".to_string();
                } else {
                    let (tx, rx) = mpsc::channel();
                    self.status_rx = Some(rx);
                    self.connecting = true;
                    let sfu_url = self.sfu_url.clone();
                    let token = self.token.clone();
                    let publish_test_media = self.publish_test_media;
                    std::thread::spawn(move || {
                        let rt = tokio::runtime::Runtime::new().expect("runtime");
                        rt.block_on(async move {
                            let _ = tx.send("Connecting to SFU...".to_string());
                            match Room::connect(&sfu_url, &token, RoomOptions::default()).await {
                                Ok((room, mut events)) => {
                                    let _ = tx.send("Connected to SFU.".to_string());
                                    if publish_test_media {
                                        if let Err(err) = publish_test_media_tracks(&room, &tx).await {
                                            let _ = tx.send(format!("Publish error: {}", err));
                                        }
                                    }
                                    while let Some(event) = events.recv().await {
                                        let _ = tx.send(format!("Event: {:?}", event));
                                    }
                                    let _ = tx.send("Disconnected from SFU.".to_string());
                                }
                                Err(err) => {
                                    let _ = tx.send(format!("Connect error: {}", err));
                                }
                            }
                        });
                    });
                }
            }

            if !self.token_preview.is_empty() {
                ui.label(format!("Token: {}", self.token_preview));
            }
            if !self.status.is_empty() {
                ui.add_space(8.0);
                ui.label(&self.status);
            }
        });
    }
}

#[derive(Serialize)]
struct LoginRequest<'a> {
    password: &'a str,
}

#[derive(Deserialize)]
struct LoginResponse {
    token: String,
}

#[derive(Serialize)]
struct TokenRequest<'a> {
    room: &'a str,
    identity: &'a str,
    name: &'a str,
}

#[derive(Deserialize)]
struct TokenResponse {
    token: String,
}

fn fetch_token(base: &str, password: &str, room: &str, identity: &str, name: &str) -> Result<String, String> {
    let client = reqwest::blocking::Client::new();
    let login = client
        .post(format!("{}/v1/auth/login", base))
        .json(&LoginRequest { password })
        .send()
        .map_err(|e| e.to_string())?;
    if !login.status().is_success() {
        return Err(format!("login failed ({})", login.status()));
    }
    let login_data: LoginResponse = login.json().map_err(|e| e.to_string())?;
    let token = client
        .post(format!("{}/v1/auth/token", base))
        .bearer_auth(login_data.token)
        .json(&TokenRequest { room, identity, name })
        .send()
        .map_err(|e| e.to_string())?;
    if !token.status().is_success() {
        return Err(format!("token failed ({})", token.status()));
    }
    let token_data: TokenResponse = token.json().map_err(|e| e.to_string())?;
    Ok(token_data.token)
}

async fn publish_test_media_tracks(room: &Room, tx: &Sender<String>) -> Result<(), String> {
    let participant = room.local_participant();

    let resolution = VideoResolution { width: 640, height: 360 };
    let video_source = NativeVideoSource::new(resolution);
    let video_track =
        LocalVideoTrack::create_video_track("test-camera", RtcVideoSource::Native(video_source.clone()));
    let mut video_opts = TrackPublishOptions::default();
    video_opts.source = TrackSource::Camera;
    participant
        .publish_track(LocalTrack::Video(video_track), video_opts)
        .await
        .map_err(|e| e.to_string())?;
    let _ = tx.send("Published test video track.".to_string());

    let audio_source =
        NativeAudioSource::new(AudioSourceOptions::default(), 48_000, 1, 100);
    let audio_track =
        LocalAudioTrack::create_audio_track("test-mic", RtcAudioSource::Native(audio_source.clone()));
    let mut audio_opts = TrackPublishOptions::default();
    audio_opts.source = TrackSource::Microphone;
    participant
        .publish_track(LocalTrack::Audio(audio_track), audio_opts)
        .await
        .map_err(|e| e.to_string())?;
    let _ = tx.send("Published test audio track.".to_string());

    spawn_test_video(video_source, tx.clone());
    spawn_test_audio(audio_source, tx.clone());
    Ok(())
}

fn spawn_test_video(source: NativeVideoSource, tx: Sender<String>) {
    tokio::spawn(async move {
        let width = source.video_resolution().width;
        let height = source.video_resolution().height;
        let mut frame_index: u64 = 0;
        let mut ticker = tokio::time::interval(Duration::from_millis(33));
        loop {
            ticker.tick().await;
            let mut buffer = I420Buffer::new(width, height);
            let (y, u, v) = buffer.data_mut();
            let y_val = ((frame_index * 3) % 255) as u8;
            y.fill(y_val);
            u.fill(128);
            v.fill(128);
            let frame = VideoFrame {
                rotation: VideoRotation::VideoRotation0,
                timestamp_us: 0,
                buffer,
            };
            source.capture_frame(&frame);
            frame_index = frame_index.wrapping_add(1);
        }
    });
    let _ = tx.send("Streaming test video frames (gray ramp).".to_string());
}

fn spawn_test_audio(source: NativeAudioSource, tx: Sender<String>) {
    let _ = tx.send("Streaming test audio (440Hz tone).".to_string());
    let tx_inner = tx.clone();
    tokio::spawn(async move {
        let sample_rate = source.sample_rate();
        let channels = source.num_channels();
        let samples_per_channel = sample_rate / 100; // 10ms
        let mut phase: f32 = 0.0;
        let phase_inc = 2.0 * PI * 440.0 / sample_rate as f32;
        let mut ticker = tokio::time::interval(Duration::from_millis(10));
        loop {
            ticker.tick().await;
            let mut frame = AudioFrame::new(sample_rate, channels, samples_per_channel);
            if let Cow::Owned(ref mut data) = frame.data {
                for sample in data.iter_mut() {
                    let value = (phase.sin() * i16::MAX as f32 * 0.05) as i16;
                    *sample = value;
                    phase += phase_inc;
                    if phase > 2.0 * PI {
                        phase -= 2.0 * PI;
                    }
                }
            }
            if let Err(err) = source.capture_frame(&frame).await {
                let _ = tx_inner.send(format!("Audio capture error: {}", err));
                break;
            }
        }
    });
}

fn main() -> eframe::Result<()> {
    let mut app = CoreApp::default();
    app.control_url = "http://127.0.0.1:9090".to_string();
    app.sfu_url = "ws://127.0.0.1:7880".to_string();
    app.room = "main".to_string();
    app.identity = "sam".to_string();
    app.name = "Sam".to_string();
    app.publish_test_media = true;

    let options = eframe::NativeOptions::default();
    eframe::run_native("Echo Chamber Core", options, Box::new(|_cc| Box::new(app)))
}
