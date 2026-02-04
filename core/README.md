# Echo Chamber Core

Echo Chamber Core is the full-stack, native version of Echo Chamber. It is designed for reliable 1080p/60 screen sharing and high-quality audio with an on-prem SFU (Selective Forwarding Unit).

This is separate from the existing web build (Echo Chamber Web). Do not mix files between the two.

## Components
- sfu: Media routing (LiveKit server). Runs on the host PC.
- control: Rust control plane (auth, rooms, admin, metrics).
- client: Native desktop app (Windows + macOS) in Rust.

## Target
- Up to 10 participants per room.
- 1080p60 for screen share where bandwidth allows.

## Status
Scaffolding in progress. This folder is the workspace for the Core build.

## Notes
- The web app remains the primary working product while Core is built.
- All Core decisions are documented in core/docs.
