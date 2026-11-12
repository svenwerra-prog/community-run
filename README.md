# Community Run

Web-App (läuft im Handy-Browser, auf dem Startbildschirm installierbar) für einen virtuellen Gemeinschaftslauf.

## Starten

Voraussetzung: Node.js 18 oder neuer.

```bash
npm install
```

```bash
npm start
```

Danach `http://localhost:3000` öffnen. Die Organisator-PIN steht beim Start in der Konsole;
mit der Umgebungsvariable `ADMIN_PIN` lässt sie sich fest einstellen.

## Für den echten Lauf

Die App muss über **https** im Internet erreichbar sein (Standort, Mikrofon und Kamera funktionieren
auf dem Handy nur über https). Jeder Node-Hoster reicht (z. B. Render, Railway, Fly.io):
Ordner hochladen, Startbefehl `npm start`, `ADMIN_PIN` setzen.

Optionale Umgebungsvariablen: `PORT`, `ADMIN_PIN`, `TURN_URL`, `TURN_USER`, `TURN_PASS`
(TURN-Server für Ton/Video in strengen Mobilfunknetzen).

## Testen ohne zu laufen

- `http://localhost:3000/?sim=3` simuliert einen Lauf mit 3 m/s.
- `?u=anna`, `?u=ben` … trennt mehrere Test-Teilnehmer im selben Browser (kombinierbar: `?sim=3&u=anna`).

## Grenzen

- Der Bildschirm muss beim Laufen an bleiben (die App hält ihn wach). Browser messen GPS nicht bei gesperrtem Handy.
- Ton/Video verbindet jeden mit jedem – gut bis etwa 6–8 Personen gleichzeitig im Call.
- Der Server merkt sich alles nur im Arbeitsspeicher; nach einem Neustart sind Rangliste und Chat leer.
