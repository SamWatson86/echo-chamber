process.env.ECHO_THEME_PREVIEW = "1";
process.env.PORT = process.env.PORT || "4188";

await import("./serve-viewer.mjs");
