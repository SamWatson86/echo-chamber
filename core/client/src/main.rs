use eframe::egui;
use serde::{Deserialize, Serialize};

#[derive(Default)]
struct CoreApp {
    server_url: String,
    room: String,
    identity: String,
    name: String,
    admin_password: String,
    status: String,
    token_preview: String,
}

impl eframe::App for CoreApp {
    fn update(&mut self, ctx: &egui::Context, _frame: &mut eframe::Frame) {
        egui::CentralPanel::default().show(ctx, |ui| {
            ui.heading("Echo Chamber Core");
            ui.label("Native client scaffold (token flow test)");
            ui.add_space(12.0);

            ui.horizontal(|ui| {
                ui.label("Control URL");
                ui.text_edit_singleline(&mut self.server_url);
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
            if ui.button("Fetch Token (Admin)").clicked() {
                self.status = "Requesting token...".to_string();
                self.token_preview.clear();
                match fetch_token(&self.server_url, &self.admin_password, &self.room, &self.identity, &self.name) {
                    Ok(token) => {
                        let preview = if token.len() > 24 { format!("{}...", &token[..24]) } else { token.clone() };
                        self.token_preview = preview;
                        self.status = "Token received.".to_string();
                    }
                    Err(err) => {
                        self.status = format!("Token error: {}", err);
                    }
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

fn main() -> eframe::Result<()> {
    let mut app = CoreApp::default();
    app.server_url = "http://127.0.0.1:9090".to_string();
    app.room = "main".to_string();
    app.identity = "sam".to_string();
    app.name = "Sam".to_string();

    let options = eframe::NativeOptions::default();
    eframe::run_native("Echo Chamber Core", options, Box::new(|_cc| Box::new(app)))
}
