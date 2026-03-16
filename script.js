const recordButton = document.getElementById("recordBtn");
const stopButton = document.getElementById("stopBtn");
const statusText = document.getElementById("status");
const transcriptBox = document.getElementById("transcript");

let mediaRecorder = null;
let mediaStream = null;
let audioChunks = [];

function setStatus(message) {
  statusText.textContent = `Status: ${message}`;
}

// Prefer formats that work well across modern mobile browsers, including Safari.
function getSupportedMimeType() {
  const candidates = [
    "audio/webm;codecs=opus",
    "audio/mp4",
    "audio/webm"
  ];

  for (const mimeType of candidates) {
    if (window.MediaRecorder && MediaRecorder.isTypeSupported(mimeType)) {
      return mimeType;
    }
  }

  return "";
}

function getFileExtension(mimeType) {
  if (mimeType.includes("mp4")) {
    return "m4a";
  }

  if (mimeType.includes("webm")) {
    return "webm";
  }

  return "wav";
}

function stopTracks() {
  if (!mediaStream) {
    return;
  }

  mediaStream.getTracks().forEach((track) => track.stop());
  mediaStream = null;
}

// Upload the finished recording to the server for Whisper transcription.
async function uploadRecording(audioBlob, extension) {
  const formData = new FormData();
  const fileName = `voice-report-${Date.now()}.${extension}`;

  formData.append("audio", audioBlob, fileName);

  setStatus("Uploading audio...");
  transcriptBox.textContent = "Processing transcription...";

  const response = await fetch("/upload", {
    method: "POST",
    body: formData
  });

  const result = await response.json();

  if (!response.ok) {
    throw new Error(result.error || "Upload failed.");
  }

  console.log("Upload successful:", result);
  transcriptBox.textContent = result.transcript || "No transcript returned.";
  setStatus("Transcript ready");
}

// Start microphone capture and buffer the audio until the user stops recording.
async function startRecording() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    setStatus("Audio recording is not supported in this browser.");
    return;
  }

  try {
    transcriptBox.textContent = "Transcript will appear here after processing.";
    setStatus("Requesting microphone access...");

    mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });

    const mimeType = getSupportedMimeType();
    const recorderOptions = mimeType ? { mimeType } : undefined;

    audioChunks = [];
    mediaRecorder = new MediaRecorder(mediaStream, recorderOptions);

    mediaRecorder.addEventListener("dataavailable", (event) => {
      if (event.data && event.data.size > 0) {
        audioChunks.push(event.data);
      }
    });

    mediaRecorder.addEventListener("stop", async () => {
      try {
        const finalMimeType = mimeType || mediaRecorder.mimeType || "audio/webm";
        const extension = getFileExtension(finalMimeType);
        const audioBlob = new Blob(audioChunks, { type: finalMimeType });

        console.log("Recording stopped. Blob size:", audioBlob.size);

        if (!audioBlob.size) {
          throw new Error("No audio captured. Please try again.");
        }

        await uploadRecording(audioBlob, extension);
      } catch (error) {
        console.error("Upload/transcription error:", error);
        transcriptBox.textContent = "Unable to process recording.";
        setStatus(error.message || "Processing failed");
      } finally {
        stopTracks();
        recordButton.disabled = false;
        stopButton.disabled = true;
      }
    });

    mediaRecorder.start();
    console.log("Recording started with mime type:", mimeType || "browser default");
    setStatus("Recording...");
    recordButton.disabled = true;
    stopButton.disabled = false;
  } catch (error) {
    console.error("Recording error:", error);
    stopTracks();
    setStatus(error.message || "Could not start recording");
  }
}

function stopRecording() {
  if (!mediaRecorder || mediaRecorder.state === "inactive") {
    return;
  }

  setStatus("Finishing recording...");
  stopButton.disabled = true;
  mediaRecorder.stop();
}

recordButton.addEventListener("click", startRecording);
stopButton.addEventListener("click", stopRecording);
