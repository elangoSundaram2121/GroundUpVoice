# GroundUp Voice Reporter

Minimal pilot web app for recording a voice message in the browser, uploading it to a Node.js server, transcribing it with OpenAI Whisper, and storing both the audio file and transcript.

## Features

- Plain HTML and JavaScript frontend
- Express backend with `POST /upload`
- Audio recording via `MediaRecorder`
- Audio upload using `fetch` and `FormData`
- Local audio storage in `uploads/`
- Transcript storage in `data/transcripts.json`
- Designed to work simply on mobile browsers, including iPhone Safari

## Project Structure

```text
groundup-voice/
├── index.html
├── script.js
├── server.js
├── package.json
├── uploads/
└── data/
```

## Requirements

- Node.js 18+
- npm
- OpenAI API key

## Local Setup

1. Install dependencies:

   ```bash
   npm install
   ```

2. Create `.env` in the project root:

   ```env
   OPENAI_API_KEY=your_openai_api_key_here
   PORT=3000
   STORAGE_DIR=.
   ```

3. Start the server:

   ```bash
   npm start
   ```

4. Open the app:

   [http://localhost:3000](http://localhost:3000)

## How It Works

1. User taps `Record`
2. Browser captures audio with `MediaRecorder`
3. User taps `Stop`
4. Frontend uploads the audio file to `POST /upload`
5. Server saves the audio file in `uploads/`
6. Server sends the audio to OpenAI Whisper using `whisper-1`
7. Server returns the transcript to the frontend
8. Server appends the transcript record to `data/transcripts.json`

## Important Notes

- Do not commit `.env`
- `.env.example` is safe to commit and use as a template
- Do not share your OpenAI API key
- `uploads/` and `data/transcripts.json` are runtime data and are ignored by Git
- For a real pilot, deploy over `https://` so microphone access works reliably on iPhone Safari

## Recommended Deployment For Daily Use

If your friend should only open one link every day and record, deploy this app to a server with:

- HTTPS
- a running Node.js process
- `OPENAI_API_KEY` configured as an environment variable
- persistent storage, so uploaded audio and transcripts are not lost

The simplest reliable approaches are:

- A small VPS such as DigitalOcean or Hetzner
- A hosted Node platform that supports persistent disk storage

## Simple Deployment Plan

1. Put this project in a GitHub repository
2. Deploy the repo to a Node hosting provider
3. Set `OPENAI_API_KEY` in the host's environment settings
4. Make sure persistent disk storage is enabled or available
5. Open the public HTTPS URL on your phone and test one recording
6. Send that URL to your friend

## Suggested Render Deployment

Render is a reasonable option if you use a plan with persistent disk support.

This repo includes a `render.yaml` file so Render can create the service and disk with fewer manual settings.

1. Push this project to GitHub
2. In Render, choose `New +` then `Blueprint`
3. Connect your GitHub account and select this repository
4. Render will read `render.yaml` and create:
   - a Node web service
   - a persistent disk mounted at `/var/data`
   - `STORAGE_DIR=/var/data/groundup-voice`
5. In Render, add the missing secret environment variable:
   - `OPENAI_API_KEY=your_real_key`
6. Deploy the service
7. Open the generated HTTPS URL and test one voice recording
8. Send that URL to your friend

If you use a platform without persistent storage, your saved recordings and transcripts may disappear after redeploys or restarts.

## Manual VPS Deployment Outline

If you want the most predictable 1-month pilot setup:

1. Create a small Ubuntu server
2. Install Node.js 18+
3. Copy the project to the server
4. Run `npm install`
5. Create `.env` with `OPENAI_API_KEY`
6. Start the app with a process manager such as `pm2`
7. Put Nginx in front of it with HTTPS
8. Send your friend the HTTPS link

This is often the safest option when you want local file storage to keep working exactly as written.
