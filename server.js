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

const whisperLanguage = process.env.WHISPER_LANGUAGE || "en";

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

function safeReadTranscriptFile() {
  return JSON.parse(fs.readFileSync(transcriptFile, "utf8") || "[]");
}

function safeWriteTranscriptFile(records) {
  fs.writeFileSync(transcriptFile, JSON.stringify(records, null, 2), "utf8");
}

function normalizeEmptyToNull(value) {
  if (value === null || value === undefined) {
    return null;
  }

  if (typeof value === "string" && value.trim() === "") {
    return null;
  }

  return value;
}

function normalizeTextField(value) {
  const cleaned = normalizeEmptyToNull(value);

  if (cleaned === null) {
    return null;
  }

  return String(cleaned).trim();
}

function parseNumberWithUnits(value) {
  if (value === null || value === undefined) {
    return null;
  }

  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  const input = String(value).toLowerCase().replace(/,/g, " ").trim();
  const match = input.match(/(\d+(?:\.\d+)?)\s*(k|thousand|lac|lakh)?/);

  if (!match) {
    return null;
  }

  const numericValue = Number(match[1]);

  if (!Number.isFinite(numericValue)) {
    return null;
  }

  const unit = match[2];

  if (unit === "k" || unit === "thousand") {
    return Math.round(numericValue * 1000);
  }

  if (unit === "lac" || unit === "lakh") {
    return Math.round(numericValue * 100000);
  }

  return Math.round(numericValue);
}

function extractRateRange(rateRaw) {
  if (!rateRaw) {
    return { rate_min: null, rate_max: null };
  }

  const input = String(rateRaw).toLowerCase().replace(/,/g, " ");
  const matches = [...input.matchAll(/(\d+(?:\.\d+)?)\s*(k|thousand|lac|lakh)?/g)];
  const values = matches
    .map((match) => parseNumberWithUnits(`${match[1]} ${match[2] || ""}`))
    .filter((value) => Number.isFinite(value));

  if (!values.length) {
    return { rate_min: null, rate_max: null };
  }

  if (values.length === 1) {
    return {
      rate_min: values[0],
      rate_max: values[0]
    };
  }

  return {
    rate_min: Math.min(...values),
    rate_max: Math.max(...values)
  };
}

async function extractLogisticsData(transcript) {
  const response = await client.chat.completions.create({
    model: "gpt-4.1-mini",
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content: [
          "Extract logistics details from the transcript.",
          "The transcript may be in any language; still extract the fields.",
          "Return strict JSON only with these keys:",
          'from, to, commodity, truck_size_tons, loads, rate_raw',
          "No explanation. Missing values must be null."
        ].join(" ")
      },
      {
        role: "user",
        content: transcript
      }
    ]
  });

  const content = response.choices[0]?.message?.content || "{}";
  const parsed = JSON.parse(content);

  return {
    from: normalizeEmptyToNull(parsed.from),
    to: normalizeEmptyToNull(parsed.to),
    commodity: normalizeEmptyToNull(parsed.commodity),
    truck_size_tons: normalizeEmptyToNull(parsed.truck_size_tons),
    loads: normalizeEmptyToNull(parsed.loads),
    rate_raw: normalizeEmptyToNull(parsed.rate_raw)
  };
}

function normalizeData(data) {
  const rateRange = extractRateRange(data.rate_raw);

  return {
    from: normalizeTextField(data.from),
    to: normalizeTextField(data.to),
    commodity: normalizeTextField(data.commodity),
    truck_size_tons: parseNumberWithUnits(data.truck_size_tons),
    loads: parseNumberWithUnits(data.loads),
    rate_min: rateRange.rate_min,
    rate_max: rateRange.rate_max
  };
}

app.get("/records", (_req, res) => {
  try {
    const records = safeReadTranscriptFile();
    return res.json(records);
  } catch (error) {
    console.error("Failed to read saved records:", error);
    return res.status(500).json({
      error: "Failed to read saved records."
    });
  }
});

function toNormalizedReport(record) {
  if (!record || typeof record !== "object") {
    return null;
  }

  if (!record.normalized || typeof record.normalized !== "object") {
    return null;
  }

  return {
    timestamp: record.timestamp || null,
    ...record.normalized
  };
}

function isTodayLocal(isoTimestamp) {
  if (!isoTimestamp) {
    return false;
  }

  const date = new Date(isoTimestamp);

  if (Number.isNaN(date.getTime())) {
    return false;
  }

  const now = new Date();

  return (
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate()
  );
}

app.get("/reports", (_req, res) => {
  try {
    const records = safeReadTranscriptFile();
    const reports = records.map(toNormalizedReport).filter(Boolean);
    return res.json(reports);
  } catch (error) {
    console.error("Failed to read reports:", error);
    return res.status(500).json({
      error: "Failed to read reports."
    });
  }
});

app.get("/reports/today", (_req, res) => {
  try {
    const records = safeReadTranscriptFile();
    const reports = records
      .map(toNormalizedReport)
      .filter(Boolean)
      .filter((report) => isTodayLocal(report.timestamp));
    return res.json(reports);
  } catch (error) {
    console.error("Failed to read today's reports:", error);
    return res.status(500).json({
      error: "Failed to read today's reports."
    });
  }
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
      model: "whisper-1",
      language: whisperLanguage
    });

    const transcriptText = (transcription.text || "").trim();
    console.log("Transcription completed");

    return res.json({
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

app.post("/submit", async (req, res) => {
  console.log("Received /submit request");

  try {
    const { audioFile, transcript } = req.body || {};
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

    const extracted = await extractLogisticsData(cleanedTranscript);
    console.log("Extraction completed");

    const normalized = normalizeData(extracted);
    console.log("Normalization completed");

    const existingTranscripts = safeReadTranscriptFile();
    const record = {
      timestamp: new Date().toISOString(),
      raw: {
        audioFile: safeAudioFile,
        transcript: cleanedTranscript
      },
      extracted,
      normalized
    };

    existingTranscripts.push(record);
    safeWriteTranscriptFile(existingTranscripts);
    console.log("Structured record saved");

    return res.json({
      transcript: cleanedTranscript,
      extracted,
      normalized
    });
  } catch (error) {
    console.error("Submit handler failed:", error);
    return res.status(500).json({
      error: "Failed to process submitted transcript."
    });
  }
});

app.listen(port, () => {
  console.log(`GroundUp Voice Reporter server running on http://localhost:${port}`);
});
