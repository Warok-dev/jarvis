# Modèles du mot d'activation

Modèles [openWakeWord](https://github.com/dscripka/openWakeWord) v0.5.1 :

- `melspectrogram.onnx`, `embedding_model.onnx` — Apache 2.0 (modèle d'embedding dérivé de
  Google speech_embedding).
- `hey_jarvis_v0.1.onnx` — CC BY-NC-SA 4.0 : **usage non commercial uniquement**, ce qui convient
  à un assistant personnel.

`test/` : phrases synthétisées avec les voix Windows (Zira, David, Hortense) pour les tests
de `src/wakeword.rs` (« Hey Jarvis » positif, phrases proches et françaises négatives).

## Empreintes SHA-256

- `embedding_model.onnx` : `70d164290c1d095d1d4ee149bc5e00543250a7316b59f31d056cff7bd3075c1f`
- `hey_jarvis_v0.1.onnx` : `94a13cfe60075b132f6a472e7e462e8123ee70861bc3fb58434a73712ee0d2cb`
- `melspectrogram.onnx` : `ba2b0e0f8b7b875369a2c89cb13360ff53bac436f2895cced9f479fa65eb176f`
