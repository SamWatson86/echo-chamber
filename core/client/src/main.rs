use eframe::egui;

#[derive(Default)]
struct CoreApp {
    server_url: String,
    room: String,
    identity: String,
    status: String,
}

impl eframe::App for CoreApp {
    fn update(&mut self, ctx: &egui::Context, _frame: &mut eframe::Frame) {
        egui::CentralPanel::default().show(ctx, |ui| {
            ui.heading("Echo Chamber Core");
            ui.label("Native client scaffold (not wired yet)");
            ui.add_space(12.0);

            ui.horizontal(|ui| {
                ui.label("Server URL");
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

            ui.add_space(8.0);
            if ui.button("Connect").clicked() {
                self.status = "Connect clicked (pending implementation)".to_string();
            }

            if !self.status.is_empty() {
                ui.add_space(8.0);
                ui.label(&self.status);
            }
        });
    }
}

fn main() -> eframe::Result<()> {
    let mut app = CoreApp::default();
    app.server_url = "http://127.0.0.1:9090".to_string();
    app.room = "main".to_string();
    app.identity = "sam".to_string();

    let options = eframe::NativeOptions::default();
    eframe::run_native("Echo Chamber Core", options, Box::new(|_cc| Box::new(app)))
}
