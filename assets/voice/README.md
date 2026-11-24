# Studio voice pack

The dashboard speaks agent narration with the browser's built-in voice, so **no
audio files or API keys are required**.

For the polished recorded demo you can drop ElevenLabs clips here. The agent
plays these keys as the run progresses:

| File | Moment |
| --- | --- |
| `intro.mp3` | Mission accepted |
| `privacy.mp3` | Cookie banner rejected |
| `extract.mp3` | Price captured |
| `handoff.mp3` | Cross-tab handoff |
| `complete.mp3` | Final line **and** the end-of-run hook |

## Generate the pack

```bash
export ELEVENLABS_API_KEY=sk_...
python scripts/generate_tts.py
```

Or drop a single finished line at `assets/voice/complete.mp3` and enable audio:

```bash
python -m aegisweb demo --audio
```

You can also point the completion hook at any file:

```bash
export AEGIS_COMPLETION_AUDIO=/path/to/your/finish-line.mp3
python -m aegisweb demo --audio
```

Audio playback uses `ffplay` (ffmpeg) when available. If no audio file, key, or
player exists, the run continues silently and the dashboard captions remain.
