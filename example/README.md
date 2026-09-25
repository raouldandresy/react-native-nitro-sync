# Nitro Sync Example

## Expo Go: test rapido

```sh
npm install
npx expo start
```

Apri l'app con Expo Go, premi **Add note** e poi **Sync now**. Questo percorso usa il transport mock e la coda in-memory del provider, quindi verifica inserimento ottimistico, update dello stato e push/pull senza richiedere un backend.

## Development build: test nativo

```sh
npx expo prebuild
npx expo run:ios
# oppure
npx expo run:android
```

La development build abilita il codice nativo e, su Android, compila `NitroSync.cpp` tramite CMake/NDK. Per una verifica completa della persistenza servono anche un provider SQLite e MMKV installati nell'app host; il transport mock rimane disponibile per isolare il comportamento della coda.
