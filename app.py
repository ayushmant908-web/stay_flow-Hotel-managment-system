
import os
import tempfile
import threading

from flask import Flask, render_template, request, jsonify
from faster_whisper import WhisperModel
from deep_translator import GoogleTranslator

BASE_DIR = os.path.dirname(os.path.abspath(__file__))

app = Flask(
    __name__,
    template_folder=os.path.join(BASE_DIR, "templates"),
    static_folder=os.path.join(BASE_DIR, "static"),
)

# CPU-friendly Whisper settings
MODEL_SIZE = "base"
whisper_model = None

model_init_lock = threading.Lock()
inference_lock = threading.Lock()

SPEECH_LANGUAGES = {
    "auto": "Auto Detect",
    "en": "English",
    "hi": "Hindi",
    "ur": "Urdu",
    "bn": "Bengali",
    "ta": "Tamil",
    "te": "Telugu",
    "mr": "Marathi",
    "gu": "Gujarati",
    "pa": "Punjabi",
    "fr": "French",
    "de": "German",
    "es": "Spanish",
    "ja": "Japanese",
    "zh": "Chinese",
    "ar": "Arabic",
    "ru": "Russian",
    "pt": "Portuguese",
}

OUTPUT_LANGUAGES = {
    "en": "English",
    "hi": "Hindi",
    "ur": "Urdu",
    "bn": "Bengali",
    "ta": "Tamil",
    "te": "Telugu",
    "mr": "Marathi",
    "gu": "Gujarati",
    "pa": "Punjabi",
    "fr": "French",
    "de": "German",
    "es": "Spanish",
    "ja": "Japanese",
    "zh-CN": "Chinese (Simplified)",
    "ar": "Arabic",
    "ru": "Russian",
    "pt": "Portuguese",
}


def get_model():
    global whisper_model

    if whisper_model is None:
        with model_init_lock:
            if whisper_model is None:
                print("Loading Faster-Whisper model...")

                whisper_model = WhisperModel(
                    MODEL_SIZE,
                    device="cpu",
                    compute_type="int8",
                    cpu_threads=4,
                )

                print("Whisper model loaded successfully.")

    return whisper_model


@app.route("/")
def index():
    return render_template(
        "index.html",
        speech_languages=SPEECH_LANGUAGES,
        output_languages=OUTPUT_LANGUAGES,
    )


@app.route("/api/health")
def health():
    return jsonify({"status": "ok"})


@app.route("/api/transcribe", methods=["POST"])
def transcribe():
    audio = request.files.get("audio")
    speech_language = request.form.get(
        "speech_language", "auto"
    )
    target_language = request.form.get(
        "target_language", "en"
    )

    if audio is None or not audio.filename:
        return jsonify({
            "error": "Audio data nahi mila."
        }), 400

    if speech_language not in SPEECH_LANGUAGES:
        return jsonify({
            "error": "Invalid spoken language."
        }), 400

    if target_language not in OUTPUT_LANGUAGES:
        return jsonify({
            "error": "Invalid translation language."
        }), 400

    temp_path = None

    try:
        # Save incoming WAV audio chunk
        with tempfile.NamedTemporaryFile(
            suffix=".wav",
            delete=False,
        ) as temp_file:
            temp_path = temp_file.name
            audio.save(temp_path)

        file_size = os.path.getsize(temp_path)

        print(f"\nReceived audio: {file_size} bytes")

        if file_size <= 44:
            return jsonify({
                "error": "Audio empty hai. Microphone dobara check karein."
            }), 400

        model = get_model()

        options = {
            "beam_size": 1,

            # Short live chunks ke liye VAD disabled
            "vad_filter": False,

            # Har chunk ko independently transcribe karein
            "condition_on_previous_text": False,
        }

        if speech_language != "auto":
            options["language"] = speech_language

        # Transcribe the complete chunk
        with inference_lock:
            segments, info = model.transcribe(
                temp_path,
                **options,
            )

            # Consume generator fully before reading the result
            segments = list(segments)

            original_text = " ".join(
                segment.text.strip()
                for segment in segments
            ).strip()

        print("Detected language:", info.language)
        print("Recognized text:", repr(original_text))

        if not original_text:
            return jsonify({
                "original_text": "",
                "translated_text": "",
                "detected_language": info.language,
                "message": (
                    "Speech detect nahi hui. "
                    "Microphone ke paas clearly bolkar try karein."
                ),
            })

        # Translate recognized text
        translated_text = ""
        translation_error = False

        try:
            translated_text = GoogleTranslator(
                source="auto",
                target=target_language,
            ).translate(original_text) or ""

            print("Translation:", repr(translated_text))

        except Exception:
            app.logger.exception("Translation failed")
            translation_error = True

        return jsonify({
            "original_text": original_text,
            "translated_text": translated_text,
            "detected_language": info.language,
            "translation_error": translation_error,
        })

    except Exception as error:
        app.logger.exception("Transcription failed")

        return jsonify({
            "error": f"Audio processing failed: {str(error)}"
        }), 500

    finally:
        if temp_path and os.path.exists(temp_path):
            try:
                os.remove(temp_path)
            except OSError:
                app.logger.warning(
                    "Temporary audio file could not be deleted."
                )


if __name__ == "__main__":
    app.run(
        host="127.0.0.1",
        port=5000,
        debug=False,
        threaded=True,
    )


