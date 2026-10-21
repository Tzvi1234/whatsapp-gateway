# gateway-transcriber

Local Hebrew STT for voice notes (decision: Tzvi 2026-10-21, ARCH §4.7). Runs on htz-home-01 as a
`systemd --user` service, listens on a **unix socket only** (`$XDG_RUNTIME_DIR/gateway-transcriber.sock`, mode 0600).

- Model: `ivrit-ai/whisper-large-v3-turbo-ct2` via faster-whisper, int8 on CPU, language forced to `he`,
  loaded once and kept resident, concurrency 1, low priority.
- Optional local fallback: ivrit-ai zipformer via sherpa-onnx (`TRANSCRIBER_ZIPFORMER_DIR`).
- No paid backend here. Soniox is an implementation in the worker behind a flag that is OFF.

## Install (as `deploy`, no sudo)
```bash
cd ~/whatsapp-gateway/services/transcriber
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
cp deploy/gateway-transcriber.service ~/.config/systemd/user/
systemctl --user daemon-reload && systemctl --user enable --now gateway-transcriber
journalctl --user -u gateway-transcriber -f   # "ready" line shows load time and RSS
```

## Spike 0.4 checklist
1. `cat /sys/fs/cgroup/user.slice/user-$UID.slice/user@$UID.service/cgroup.controllers` contains `memory`.
2. Transcribe real Hebrew voice notes from the test number; record peak `rss_mb` (from `/health`) and
   RTF = elapsed_ms / (duration_s*1000). Set `MemoryMax` to peak RSS + ~20%.
3. Note WER on a spot-check (TEST-PLAN L3.9).

## Tests
```bash
python3 -m unittest discover -s tests -t .
```
