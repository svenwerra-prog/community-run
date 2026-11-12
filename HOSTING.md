# Community Run ins Internet bringen (Render)

Ziel: eine feste https-Adresse wie `https://community-run.onrender.com`, die alle Teilnehmer auf dem Handy öffnen.
Du brauchst zwei kostenlose Konten: **GitHub** (dort liegt der Code) und **Render** (dort läuft die App).
Git muss auf deinem Rechner nicht installiert sein – alles geht im Browser.

## 1. Code zu GitHub hochladen

1. Auf github.com ein Konto anlegen bzw. anmelden.
2. Oben rechts **+ → New repository**. Name: `community-run`, Sichtbarkeit **Private**, dann **Create repository**.
3. Auf der leeren Repository-Seite **uploading an existing file** anklicken.
4. Den Inhalt des Ordners `community-run` ins Browserfenster ziehen – **alles außer `node_modules`**:
   `public` (ganzer Ordner), `server.js`, `package.json`, `package-lock.json`, `render.yaml`, `Dockerfile`,
   `.gitignore`, `.dockerignore`, `README.md`, `HOSTING.md`.
5. **Commit changes** klicken.

## 2. App bei Render einrichten

1. Auf render.com ein Konto anlegen – am einfachsten mit **Sign in with GitHub**.
2. **New → Blueprint** wählen und das Repository `community-run` verbinden
   (Render fragt nach Zugriff auf GitHub; es reicht der Zugriff auf dieses eine Repository).
3. Render liest die Datei `render.yaml` und fragt nach **ADMIN_PIN**: Hier deine eigene Organisator-PIN eintragen
   (mindestens 6 Ziffern, nicht weitergeben).
4. **Apply / Deploy** klicken. Nach ein bis zwei Minuten steht oben die Adresse der App.

## 3. Prüfen

1. Adresse am Handy öffnen, Standort erlauben, als Organisator mit der PIN beitreten.
2. Auf einem zweiten Handy als normaler Teilnehmer beitreten.
3. Kurzen Probelauf starten (z. B. Zieldistanz 0,2 km) und einmal den Call mit Ton und Video ausprobieren.
4. Tipp: Im Browser-Menü **„Zum Startbildschirm hinzufügen“** – dann startet die App wie eine normale App.

## Vor dem Lauftag wichtig

- **Gratis-Tarif schläft ein:** Ohne Besucher wird der Dienst nach einigen Minuten pausiert; der erste Aufruf dauert
  dann bis zu einer Minute. Öffne die App deshalb rechtzeitig vor dem Start. Solange jemand angemeldet ist, hält die
  App den Server wach. Wer ganz sicher gehen will, stellt in Render für den Lauftag auf den kleinsten bezahlten Tarif
  um (Einstellung „Instance Type“) – danach wieder zurück.
- **Nicht neu deployen, während ein Lauf läuft:** Ein Neustart leert Rangliste und Chat.
- **Call hinter strengen Netzen:** Wenn sich einzelne Teilnehmer im Mobilfunk nicht hören, fehlt ein TURN-Server.
  Zugangsdaten eines TURN-Anbieters in Render unter **Environment** als `TURN_URL`, `TURN_USER`, `TURN_PASS` eintragen.
- **Änderungen einspielen:** Geänderte Dateien bei GitHub erneut hochladen – Render aktualisiert die App automatisch.
