
const startButton = document.getElementById("startButton");
const stopButton = document.getElementById("stopButton");
const clearButton = document.getElementById("clearButton");

const speechLanguage = document.getElementById("speechLanguage");
const targetLanguage = document.getElementById("targetLanguage");

const micOrbit = document.getElementById("micOrbit");
const statusTitle = document.getElementById("statusTitle");
const statusText = document.getElementById("statusText");
const statusDot = document.getElementById("statusDot");
const statusLabel = document.getElementById("statusLabel");
const timerElement = document.getElementById("timer");
const detectedLanguage = document.getElementById("detectedLanguage");
const targetLabel = document.getElementById("targetLabel");

const originalElement = document.getElementById("originalText");
const translatedElement = document.getElementById("translatedText");

const CHUNK_SECONDS = 4;

let mediaStream = null;
let audioContext = null;
let sourceNode = null;
let processorNode = null;
let muteNode = null;

let isRecording = false;
let isStopping = false;
let recordingStartedAt = 0;
let timerInterval = null;

let pendingSamples = [];
let pendingSampleCount = 0;
let uploadQueue = Promise.resolve();

let originalTranscript = "";
let translatedTranscript = "";

const languageNames = {
    en: "English",
    hi: "Hindi",
    ur: "Urdu",
    bn: "Bengali",
    ta: "Tamil",
    te: "Telugu",
    mr: "Marathi",
    gu: "Gujarati",
    pa: "Punjabi",
    fr: "French",
    de: "German",
    es: "Spanish",
    ja: "Japanese",
    zh: "Chinese",
    ar: "Arabic",
    ru: "Russian",
    pt: "Portuguese"
};

function updateTargetLabel() {
    targetLabel.textContent =
        targetLanguage.options[targetLanguage.selectedIndex].text;
}

targetLanguage.addEventListener("change", updateTargetLabel);
updateTargetLabel();

function setStatus(recording, title, message) {
    statusTitle.textContent = title;
    statusText.textContent = message;
    statusLabel.textContent = recording
        ? "Microphone active"
        : "Microphone off";

    statusDot.classList.toggle("active", recording);
    micOrbit.classList.toggle("listening", recording);

    startButton.disabled = recording || isStopping;
    stopButton.disabled = !recording || isStopping;

    speechLanguage.disabled = recording || isStopping;
    targetLanguage.disabled = recording || isStopping;
}

function updateTimer() {
    if (!recordingStartedAt) return;

    const totalSeconds = Math.floor(
        (Date.now() - recordingStartedAt) / 1000
    );

    const minutes = String(Math.floor(totalSeconds / 60)).padStart(2, "0");
    const seconds = String(totalSeconds % 60).padStart(2, "0");

    timerElement.textContent = `${minutes}:${seconds}`;
}

function appendText(element, text, isOriginal) {
    if (!text) return;

    const placeholder = isOriginal
        ? "Your spoken words will appear here..."
        : "Translation will appear here...";

    if (element.textContent.trim() === placeholder) {
        element.textContent = text;
    } else {
        element.textContent += "\n" + text;
    }

    // Keep the newest transcript visible.
    element.scrollTop = element.scrollHeight;
}

function takeSamples(count) {
    const output = new Float32Array(count);
    let written = 0;

    while (written < count && pendingSamples.length > 0) {
        const first = pendingSamples[0];
        const needed = count - written;
        const amount = Math.min(first.length, needed);

        output.set(first.subarray(0, amount), written);
        written += amount;

        if (amount === first.length) {
            pendingSamples.shift();
        } else {
            pendingSamples[0] = first.subarray(amount);
        }

        pendingSampleCount -= amount;
    }

    return output.subarray(0, written);
}

function makeWavBlob(samples, sampleRate) {
    const bytesPerSample = 2;
    const buffer = new ArrayBuffer(44 + samples.length * bytesPerSample);
    const view = new DataView(buffer);

    function writeString(offset, value) {
        for (let i = 0; i < value.length; i++) {
            view.setUint8(offset + i, value.charCodeAt(i));
        }
    }

    writeString(0, "RIFF");
    view.setUint32(4, 36 + samples.length * 2, true);
    writeString(8, "WAVE");
    writeString(12, "fmt ");
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);  // PCM
    view.setUint16(22, 1, true);  // Mono
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * bytesPerSample, true);
    view.setUint16(32, bytesPerSample, true);
    view.setUint16(34, 16, true);
    writeString(36, "data");
    view.setUint32(40, samples.length * bytesPerSample, true);

    let offset = 44;

    for (let i = 0; i < samples.length; i++, offset += 2) {
        const sample = Math.max(-1, Math.min(1, samples[i]));
        const pcm = sample < 0
            ? sample * 32768
            : sample * 32767;

        view.setInt16(offset, pcm, true);
    }

    return new Blob([buffer], { type: "audio/wav" });
}

function queueSamples(samples) {
    if (!samples || samples.length === 0) return;

    const sampleRate = audioContext.sampleRate;
    const blob = makeWavBlob(samples, sampleRate);

    // Process chunks sequentially so the CPU model is not overloaded.
    uploadQueue = uploadQueue
        .then(() => sendChunk(blob))
        .catch(error => {
            console.error("Chunk processing failed:", error);
            statusText.textContent =
                "Ek audio chunk process nahi hua. Agla chunk try ho raha hai.";
        });
}

function sendFullChunks() {
    const chunkSize = Math.floor(
        audioContext.sampleRate * CHUNK_SECONDS
    );

    while (pendingSampleCount >= chunkSize) {
        const samples = takeSamples(chunkSize);
        queueSamples(samples);
    }
}

async function sendChunk(blob) {
    const formData = new FormData();

    formData.append("audio", blob, "live-audio.wav");
    formData.append("speech_language", speechLanguage.value);
    formData.append("target_language", targetLanguage.value);

    statusText.textContent = "Transcribing your speech...";

    const response = await fetch("/api/transcribe", {
        method: "POST",
        body: formData
    });

    const data = await response.json();

    if (!response.ok) {
        throw new Error(data.error || "Transcription failed");
    }

    if (data.original_text) {
        appendText(originalElement, data.original_text, true);

        originalTranscript +=
            (originalTranscript ? "\n" : "") + data.original_text;

        detectedLanguage.textContent =
            "Detected: " +
            (languageNames[data.detected_language] ||
             data.detected_language ||
             "Unknown");
    }

    if (data.translated_text) {
        appendText(translatedElement, data.translated_text, false);

        translatedTranscript +=
            (translatedTranscript ? "\n" : "") + data.translated_text;
    }

    if (data.translation_error) {
        statusText.textContent =
            "Transcript aa gaya, lekin translation ke liye internet check karein.";
    } else if (isRecording) {
        statusText.textContent =
            "Listening... keep speaking. Text updates automatically.";
    }
}

async function startListening() {
    if (isRecording || isStopping) return;

    if (!navigator.mediaDevices?.getUserMedia ||
        !window.AudioContext && !window.webkitAudioContext) {
        alert("Please use an updated Chrome or Edge browser.");
        return;
    }

    try {
        setStatus(false, "Connecting microphone...", "Please allow microphone access.");

        mediaStream = await navigator.mediaDevices.getUserMedia({
            audio: {
                channelCount: 1,
                echoCancellation: true,
                noiseSuppression: true,
                autoGainControl: true
            }
        });

        const AudioContextClass =
            window.AudioContext || window.webkitAudioContext;

        audioContext = new AudioContextClass();
        await audioContext.resume();

        sourceNode = audioContext.createMediaStreamSource(mediaStream);

        // ScriptProcessorNode captures continuous microphone audio.
        processorNode = audioContext.createScriptProcessor(4096, 1, 1);
        muteNode = audioContext.createGain();
        muteNode.gain.value = 0;

        pendingSamples = [];
        pendingSampleCount = 0;
        uploadQueue = Promise.resolve();

        processorNode.onaudioprocess = event => {
            if (!isRecording) return;

            const input = event.inputBuffer.getChannelData(0);
            const copy = new Float32Array(input);

            pendingSamples.push(copy);
            pendingSampleCount += copy.length;

            sendFullChunks();
        };

        sourceNode.connect(processorNode);
        processorNode.connect(muteNode);
        muteNode.connect(audioContext.destination);

        isRecording = true;
        recordingStartedAt = Date.now();

        setStatus(
            true,
            "Listening to your voice...",
            "Speak clearly. Your text will appear below."
        );

        timerElement.textContent = "00:00";
        timerInterval = setInterval(updateTimer, 250);

    } catch (error) {
        console.error(error);
        await cleanupAudio();

        setStatus(
            false,
            "Microphone unavailable",
            "Browser settings mein microphone permission allow karein."
        );

        alert("Microphone start nahi hua. Permission aur browser settings check karein.");
    }
}

async function cleanupAudio() {
    if (processorNode) {
        processorNode.onaudioprocess = null;
        try { processorNode.disconnect(); } catch {}
        processorNode = null;
    }

    if (sourceNode) {
        try { sourceNode.disconnect(); } catch {}
        sourceNode = null;
    }

    if (muteNode) {
        try { muteNode.disconnect(); } catch {}
        muteNode = null;
    }

    if (mediaStream) {
        mediaStream.getTracks().forEach(track => track.stop());
        mediaStream = null;
    }

    if (audioContext) {
        try { await audioContext.close(); } catch {}
        audioContext = null;
    }
}

async function stopListening() {
    if (!isRecording || isStopping) return;

    isStopping = true;
    isRecording = false;

    if (timerInterval) {
        clearInterval(timerInterval);
        timerInterval = null;
    }

    updateTimer();

    setStatus(false, "Finishing transcription...", "Processing the last audio chunk.");

    // Process remaining audio shorter than four seconds.
    if (audioContext && pendingSampleCount > 0) {
        queueSamples(takeSamples(pendingSampleCount));
    }

    await cleanupAudio();

    // Wait for all queued audio chunks to finish.
    await uploadQueue;

    isStopping = false;
    recordingStartedAt = 0;

    setStatus(
        false,
        "Recording finished",
        "Your available transcript and translation are shown below."
    );

    startButton.disabled = false;
    stopButton.disabled = true;
    speechLanguage.disabled = false;
    targetLanguage.disabled = false;
}

startButton.addEventListener("click", startListening);
stopButton.addEventListener("click", stopListening);

clearButton.addEventListener("click", () => {
    if (isRecording || isStopping) {
        alert("Clear karne se pehle recording stop karein.");
        return;
    }

    originalTranscript = "";
    translatedTranscript = "";

    originalElement.textContent = "Your spoken words will appear here...";
    translatedElement.textContent = "Translation will appear here...";
    detectedLanguage.textContent = "Waiting for speech";
    timerElement.textContent = "00:00";
});

document.querySelectorAll("[data-copy]").forEach(button => {
    button.addEventListener("click", async () => {
        const element = document.getElementById(button.dataset.copy);

        try {
            await navigator.clipboard.writeText(element.textContent);
            const oldText = button.textContent;
            button.textContent = "Copied!";
            setTimeout(() => button.textContent = oldText, 1200);
        } catch {
            alert("Copy nahi hua. Text select karke manually copy karein.");
        }
    });
});

document.querySelectorAll("[data-download]").forEach(button => {
    button.addEventListener("click", () => {
        const element = document.getElementById(button.dataset.download);
        const blob = new Blob([element.textContent], {
            type: "text/plain;charset=utf-8"
        });

        const url = URL.createObjectURL(blob);
        const link = document.createElement("a");

        link.href = url;
        link.download = button.dataset.download === "originalText"
            ? "original-transcript.txt"
            : "translated-transcript.txt";

        document.body.appendChild(link);
        link.click();
        link.remove();

        URL.revokeObjectURL(url);
    });
});

window.addEventListener("beforeunload", () => {
    if (timerInterval) clearInterval(timerInterval);

    if (mediaStream) {
        mediaStream.getTracks().forEach(track => track.stop());
    }
});

