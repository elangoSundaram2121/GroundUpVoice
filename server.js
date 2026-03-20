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

function createEmptyContext() {
  return {
    departure_time: "",
    arrival_estimate: "",
    notes: "",
    signals: []
  };
}

function normalizeSignalList(value) {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((item) => String(item || "").trim())
    .filter(Boolean);
}

function normalizeExtractedContext(value) {
  if (!value || typeof value !== "object") {
    return createEmptyContext();
  }

  return {
    departure_time: normalizeTextField(value.departure_time) || "",
    arrival_estimate: normalizeTextField(value.arrival_estimate) || "",
    notes: normalizeTextField(value.notes) || "",
    signals: normalizeSignalList(value.signals)
  };
}

function normalizeClockTime(value) {
  const cleaned = normalizeTextField(value);

  if (!cleaned) {
    return "";
  }

  const input = cleaned
    .toLowerCase()
    .replace(/[.,]/g, " ")
    .replace(/\b(around|about|approximately|approx|at|by)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  const twentyFourHourMatch = input.match(/^([01]?\d|2[0-3]):([0-5]\d)$/);

  if (twentyFourHourMatch) {
    return `${String(Number(twentyFourHourMatch[1])).padStart(2, "0")}:${twentyFourHourMatch[2]}`;
  }

  const twelveHourMatch = input.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)$/);

  if (!twelveHourMatch) {
    return cleaned;
  }

  let hours = Number(twelveHourMatch[1]);
  const minutes = twelveHourMatch[2] || "00";
  const meridiem = twelveHourMatch[3];

  if (!Number.isInteger(hours) || hours < 1 || hours > 12) {
    return cleaned;
  }

  if (meridiem === "am") {
    hours = hours === 12 ? 0 : hours;
  } else {
    hours = hours === 12 ? 12 : hours + 12;
  }

  return `${String(hours).padStart(2, "0")}:${minutes}`;
}

function normalizeArrivalEstimate(value) {
  const cleaned = normalizeTextField(value);

  if (!cleaned) {
    return "";
  }

  const input = cleaned
    .toLowerCase()
    .replace(/[.,]/g, " ")
    .replace(/\b(by|around|about|approximately|approx)\b/g, " ")
    .replace(/\b(will\s+)?(reach|reaching|arrive|arriving|arrival)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (/\btomorrow\b/.test(input) && /\bmorning\b/.test(input)) {
    return "next_day_morning";
  }

  if (/\btomorrow\b/.test(input) && /\bafternoon\b/.test(input)) {
    return "next_day_afternoon";
  }

  if (/\btomorrow\b/.test(input) && /\bevening\b/.test(input)) {
    return "next_day_evening";
  }

  if (/\btomorrow\b/.test(input) && /\bnight\b/.test(input)) {
    return "next_day_night";
  }

  const normalizedTime = normalizeClockTime(cleaned);
  return normalizedTime || cleaned;
}

function normalizeContext(context) {
  const extractedContext = normalizeExtractedContext(context);

  return {
    departure_time: normalizeClockTime(extractedContext.departure_time),
    arrival_estimate: normalizeArrivalEstimate(extractedContext.arrival_estimate),
    signals: extractedContext.signals,
    notes: extractedContext.notes
  };
}

function parseNumberWithUnits(value) {
  if (value === null || value === undefined) {
    return null;
  }

  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  let input = String(value).toLowerCase().trim();
  input = input.replace(/,/g, "");
  while (/\d\s+\d{3}\b/.test(input)) {
    input = input.replace(/(\d)\s+(\d{3}\b)/g, "$1$2");
  }
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

  let input = String(rateRaw).toLowerCase();
  input = input.replace(/,/g, "");
  while (/\d\s+\d{3}\b/.test(input)) {
    input = input.replace(/(\d)\s+(\d{3}\b)/g, "$1$2");
  }
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
          'from, to, commodity, truck_size_tons, loads, rate_raw, context',
          "context must be an object with these keys:",
          'departure_time, arrival_estimate, notes, signals',
          "Keep the existing extraction behavior for the top-level fields.",
          "Only extract values that are clearly stated in the transcript.",
          "Do not infer or guess missing values.",
          "Top-level missing scalar values must be null.",
          "For missing context strings, return an empty string.",
          "For missing signals, return an empty array.",
          'signals must only contain clearly stated labels such as "driver_shortage", "truck_shortage", or "delayed_loads".',
          "notes should contain only additional useful logistics context not already captured elsewhere; otherwise return an empty string.",
          "No explanation."
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
    rate_raw: normalizeEmptyToNull(parsed.rate_raw),
    context: normalizeExtractedContext(parsed.context)
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
    rate_max: rateRange.rate_max,
    context: normalizeContext(data.context)
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
    const safeAudioFile = audioFile ? path.basename(audioFile) : "";

    if (!cleanedTranscript) {
      return res.status(400).json({
        error: "Transcript is required."
      });
    }

    if (safeAudioFile) {
      const storedAudioPath = path.join(uploadsDir, safeAudioFile);

      if (!fs.existsSync(storedAudioPath)) {
        console.error("Uploaded audio file not found:", storedAudioPath);
        return res.status(400).json({
          error: "Uploaded audio file could not be found."
        });
      }
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
