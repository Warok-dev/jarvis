# Modèles du mot d'activation

Modèles [openWakeWord](https://github.com/dscripka/openWakeWord) v0.5.1 :

- `melspectrogram.onnx`, `embedding_model.onnx` — Apache 2.0 (modèle d'embedding dérivé de
  Google speech_embedding).
- `hey_jarvis_v0.1.onnx` — CC BY-NC-SA 4.0 : **usage non commercial uniquement**, ce qui convient
  à un assistant personnel.

`test/` : phrases synthétisées avec les voix Windows (Zira, David, Hortense) pour les tests
de `src/wakeword.rs` (« Hey Jarvis » positif, phrases proches et françaises négatives).
