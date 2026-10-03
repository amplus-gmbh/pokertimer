# Table Time

Pokerturnier-Blindtimer für Node.js mit MySQL-Persistenz. Die Oberfläche ist auf Deutsch; Blindstrukturen können manuell gepflegt, als JSON importiert/exportiert oder optional über eine OpenAI-kompatible API erzeugt werden.

## Lokal starten

Voraussetzung: Node.js 18.17 oder neuer.

```powershell
Copy-Item .env.example .env
npm install
npm start
```

Ohne `DB_*`-Konfiguration startet die App im lokalen Arbeitsspeicher. Für dauerhafte Speicherung MySQL konfigurieren. Die KI-Funktion bleibt ohne `OPENAI_API_KEY` deaktiviert; JSON-Import und manuelle Bearbeitung funktionieren trotzdem.

## Blindstruktur-JSON

```json
{
  "levels": [
    { "smallBlind": 25, "bigBlind": 50, "ante": 0, "durationMinutes": 20, "type": "level" },
    { "smallBlind": 50, "bigBlind": 100, "ante": 10, "durationMinutes": 20, "type": "level" },
    { "smallBlind": 0, "bigBlind": 0, "ante": 0, "durationMinutes": 10, "type": "break" }
  ]
}
```

Zulässig sind 1 bis 100 Einträge, Level von 1 bis 240 Minuten und Pausen mit denselben Zeitgrenzen. Ein Rebuy fügt einen Buy-in und Startstack hinzu. Der Average Stack ist Gesamtchips geteilt durch Spieler im Spiel. Auszahlungen ergeben sich aus den Prozentanteilen, die zusammen 100 % sein sollten.

## Hostinger Deployment

1. In hPanel eine MySQL-Datenbank und einen Datenbankbenutzer anlegen und diesem Benutzer alle Rechte auf diese Datenbank geben. Hostinger zeigt die konkreten Werte für Host, Datenbankname und Benutzer an; den Host nicht ungeprüft als `localhost` übernehmen.
2. Die Dateien per Git-Deployment oder Upload ins App-Verzeichnis deployen. In hPanel unter **Websites → Verwalten → Erweitert → Node.js** (Bezeichnung kann je nach Tarif variieren) eine Node.js-App anlegen. Startdatei: `server.js`; Node-Version: 18.17 oder neuer. Falls hPanel einen Startbefehl verlangt: `npm start`.
3. Als Umgebungsvariablen in der Node.js-App-Konfiguration eintragen (ohne Anführungszeichen, keine `.env`-Datei ins öffentliche Deployment hochladen):

| Variable | Wert |
| --- | --- |
| `NODE_ENV` | `production` |
| `PORT` | Von Hostinger vorgegeben; falls nicht automatisch gesetzt, `3000` |
| `DB_HOST` | MySQL-Host aus hPanel |
| `DB_PORT` | `3306` (sofern hPanel keinen anderen Port zeigt) |
| `DB_NAME` | Datenbankname aus hPanel |
| `DB_USER` | Datenbankbenutzer aus hPanel |
| `DB_PASSWORD` | Datenbankpasswort |
| `APP_USER` | Gewünschter Benutzername für den Timer |
| `APP_PASSWORD` | Langes, einzigartiges Passwort für den Timer |
| `OPENAI_API_KEY` | Optional; nur falls KI-Generierung gewünscht |
| `OPENAI_MODEL` | Optional, Standard `gpt-4o-mini` |
| `OPENAI_BASE_URL` | Optional, Standard `https://api.openai.com/v1` |

4. Abhängigkeiten installieren lassen (`npm install` im App-Verzeichnis), App starten und die Subdomain `pokertimer.geekz.ch` in hPanel dieser Node.js-App zuordnen. SSL/HTTPS für die Subdomain aktivieren. Nach Änderungen an Umgebungsvariablen die Node-App neu starten.
5. Mit `https://pokertimer.geekz.ch` prüfen. Der Browser fragt nach `APP_USER` und `APP_PASSWORD`. Der erste Start legt die Tabelle `tournament_state` automatisch an; die Zugangsdaten benötigen dafür `CREATE TABLE`-Rechte.

**Wichtig:** Hostinger-Tarife unterscheiden sich darin, ob Node.js-Apps und Git-Deployment verfügbar sind. Wenn Node.js im Tarif nicht angeboten wird, kann diese App dort nicht als Node-Prozess laufen; dann ist ein Node-fähiger Tarif/VPS nötig. Die KI-API-Kosten richten sich nach dem konfigurierten Anbieter.
