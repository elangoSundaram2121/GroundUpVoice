const recordButton = document.getElementById("recordBtn");
const stopButton = document.getElementById("stopBtn");
const submitButton = document.getElementById("submitBtn");
const statusText = document.getElementById("status");
const transcriptBox = document.getElementById("transcript");

let mediaRecorder = null;
let mediaStream = null;
let audioChunks = [];
let pendingSubmission = null;

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

function resetPendingSubmission() {
  pendingSubmission = null;
  transcriptBox.value = "";
  transcriptBox.disabled = true;
  submitButton.disabled = true;
}

function updateSubmitButtonState() {
  const hasPendingUpload = Boolean(pendingSubmission && pendingSubmission.audioFile);
  const hasTranscriptText = transcriptBox.value.trim().length > 0;
  submitButton.disabled = !(hasPendingUpload && hasTranscriptText);
}

// Upload the finished recording to the server for Whisper transcription.
async function uploadRecording(audioBlob, extension) {
  const formData = new FormData();
  const fileName = `voice-report-${Date.now()}.${extension}`;

  formData.append("audio", audioBlob, fileName);

  setStatus("Uploading audio...");
  transcriptBox.value = "";
  transcriptBox.placeholder = "Processing transcription...";
  transcriptBox.disabled = true;
  submitButton.disabled = true;

  const response = await fetch("/upload", {
    method: "POST",
    body: formData
  });

  const result = await response.json();

  if (!response.ok) {
    throw new Error(result.error || "Upload failed.");
  }

  console.log("Upload successful:", result);
  pendingSubmission = {
    audioFile: result.audioFile,
    originalName: result.originalName,
    mimeType: result.mimeType
  };
  transcriptBox.disabled = false;
  transcriptBox.value = result.transcript || "";
  transcriptBox.placeholder = "Edit the transcript if needed before submitting.";
  updateSubmitButtonState();
  setStatus("Review transcript and tap Submit");
}

// Save the reviewed transcript only after the user confirms it.
async function submitTranscript() {
  if (!pendingSubmission || !pendingSubmission.audioFile) {
    setStatus("Record audio first");
    return;
  }

  const transcript = transcriptBox.value.trim();

  if (!transcript) {
    setStatus("Transcript cannot be empty");
    updateSubmitButtonState();
    return;
  }

  try {
    submitButton.disabled = true;
    setStatus("Submitting report...");

    const response = await fetch("/submit", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        audioFile: pendingSubmission.audioFile,
        originalName: pendingSubmission.originalName,
        mimeType: pendingSubmission.mimeType,
        transcript
      })
    });

    const result = await response.json();

    if (!response.ok) {
      throw new Error(result.error || "Submit failed.");
    }

    console.log("Submit successful:", result);
    transcriptBox.value = transcript;
    transcriptBox.disabled = true;
    pendingSubmission = null;
    submitButton.disabled = true;
    setStatus("Report submitted successfully");
  } catch (error) {
    console.error("Submit error:", error);
    setStatus(error.message || "Submit failed");
    updateSubmitButtonState();
  }
}

// Start microphone capture and buffer the audio until the user stops recording.
async function startRecording() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    setStatus("Audio recording is not supported in this browser.");
    return;
  }

  try {
    resetPendingSubmission();
    transcriptBox.placeholder = "Transcript will appear here after processing.";
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
        resetPendingSubmission();
        transcriptBox.placeholder = "Unable to process recording.";
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
submitButton.addEventListener("click", submitTranscript);
transcriptBox.addEventListener("input", updateSubmitButtonState);
