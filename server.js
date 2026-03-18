require("dotenv").config();

const express = require("express");
const multer = require("multer");
const OpenAI = require("openai");
const fs = require("fs");
const path = require("path");

const app = express();
const port = process.env.PORT || 3000;

const storageRoot = process.env.STORAGE_DIR
  ? path.resolve(process.env.STORAGE_DIR)
  : __dirname;
const uploadsDir = path.join(storageRoot, "uploads");
const dataDir = path.join(storageRoot, "data");
const transcriptFile = path.join(dataDir, "transcripts.json");
const indexFile = path.join(__dirname, "index.html");
const scriptFile = path.join(__dirname, "script.js");

// Ensure local storage paths exist before handling requests.
fs.mkdirSync(uploadsDir, { recursive: true });
fs.mkdirSync(dataDir, { recursive: true });

if (!fs.existsSync(transcriptFile)) {
  fs.writeFileSync(transcriptFile, "[]", "utf8");
}

console.log("Using storage root:", storageRoot);

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

const storage = multer.diskStorage({
  destination: (_req, _file, callback) => {
    callback(null, uploadsDir);
  },
  filename: (_req, file, callback) => {
    const extension = path.extname(file.originalname) || ".webm";
    const safeExtension = extension.replace(/[^a-zA-Z0-9.]/g, "") || ".webm";
    callback(null, `recording-${Date.now()}${safeExtension}`);
  }
});

const upload = multer({ storage });

app.use(express.json());

// Serve only the minimal frontend assets needed by the prototype.
app.get("/", (_req, res) => {
  res.sendFile(indexFile);
});

app.get("/script.js", (_req, res) => {
  res.sendFile(scriptFile);
});

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

app.post("/upload", upload.single("audio"), async (req, res) => {
  console.log("Received /upload request");

  try {
    if (!process.env.OPENAI_API_KEY) {
      console.error("Missing OPENAI_API_KEY");
      return res.status(500).json({
        error: "Server is missing OPENAI_API_KEY."
      });
    }

    if (!req.file) {
      console.error("No audio file provided");
      return res.status(400).json({
        error: "No audio file uploaded."
      });
    }

    console.log("Saved upload:", req.file.path);

    const transcription = await client.audio.transcriptions.create({
      file: fs.createReadStream(req.file.path),
      model: "whisper-1"
    });

    const transcriptText = (transcription.text || "").trim();
    console.log("Transcription completed");

    return res.json({
      success: true,
      transcript: transcriptText,
      audioFile: path.basename(req.file.path),
      originalName: req.file.originalname,
      mimeType: req.file.mimetype
    });
  } catch (error) {
    console.error("Upload handler failed:", error);
    return res.status(500).json({
      error: "Failed to process audio transcription."
    });
  }
});

app.post("/submit", (req, res) => {
  console.log("Received /submit request");

  try {
    const { audioFile, originalName, mimeType, transcript } = req.body || {};
    const cleanedTranscript = String(transcript || "").trim();

    if (!audioFile || !cleanedTranscript) {
      return res.status(400).json({
        error: "Audio file and transcript are required."
      });
    }

    const safeAudioFile = path.basename(audioFile);
    const storedAudioPath = path.join(uploadsDir, safeAudioFile);

    if (!fs.existsSync(storedAudioPath)) {
      console.error("Uploaded audio file not found:", storedAudioPath);
      return res.status(400).json({
        error: "Uploaded audio file could not be found."
      });
    }

    const existingTranscripts = JSON.parse(
      fs.readFileSync(transcriptFile, "utf8") || "[]"
    );

    const transcriptRecord = {
      id: Date.now(),
      createdAt: new Date().toISOString(),
      audioFile: safeAudioFile,
      originalName: originalName || safeAudioFile,
      mimeType: mimeType || "application/octet-stream",
      transcript: cleanedTranscript
    };

    existingTranscripts.push(transcriptRecord);
    fs.writeFileSync(
      transcriptFile,
      JSON.stringify(existingTranscripts, null, 2),
      "utf8"
    );

    return res.json({
      success: true,
      message: "Report saved successfully."
    });
  } catch (error) {
    console.error("Submit handler failed:", error);
    return res.status(500).json({
      error: "Failed to save transcript."
    });
  }
});

app.listen(port, () => {
  console.log(`GroundUp Voice Reporter server running on http://localhost:${port}`);
});
