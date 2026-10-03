# Table Time

Pokerturnier-Blindtimer für Node.js mit MySQL-Persistenz. Die Oberfläche ist auf Deutsch; Blindstrukturen können manuell gepflegt, als JSON importiert/exportiert oder über einen beliebigen KI-Chat erstellt werden: Die App erzeugt einen Prompt zum Kopieren, die Antwort wird wieder eingefügt.

## Lokal starten

Voraussetzung: Node.js 18.17 oder neuer.

```powershell
Copy-Item .env.example .env
npm install
npm start
```

Ohne `DB_*`-Konfiguration startet die App im lokalen Arbeitsspeicher. Für dauerhafte Speicherung MySQL konfigurieren.

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

## Turniere und Zugriff

Die App ist öffentlich und braucht kein Login. Jeder Browser bekommt beim ersten Aufruf ein eigenes Turnier mit zufälliger ID; sie steht in der Adresse (`?t=…`). Wer diesen Link öffnet, z. B. auf einem zweiten Gerät, steuert dasselbe Turnier. Den Link deshalb nur an Mitspielende weitergeben. Turniere, die 180 Tage nicht verändert wurden, löscht der Server automatisch.

## Blindstruktur mit KI-Chat

Vorgaben eintragen, „Prompt kopieren“ klicken und den Prompt in ChatGPT, Claude o. Ä. einfügen. Die Antwort komplett zurück ins Feld „Antwort der KI einfügen“ kopieren und übernehmen; Codeblöcke und Begleittext werden ignoriert. Spieler und Startstack fliessen automatisch in den Prompt ein.

## Hostinger Deployment

Voraussetzung: Business-Webhosting oder ein Cloud-Tarif (nur diese bieten Node.js-Web-Apps in hPanel). Auf einem VPS läuft die App auch, muss dort aber manuell eingerichtet werden.

### 1. Datenbank anlegen

hPanel → **Websites → (geekz.ch) → Datenbanken → MySQL-Datenbanken** → neue Datenbank mit eigenem Benutzer anlegen. Datenbankname, Benutzer und Passwort notieren; Hostinger stellt dem Namen und Benutzer ein Präfix voran (z. B. `u123456789_pokertimer`). Der Host ist für Apps auf demselben Hosting `localhost`.

### 2. Node.js-Web-App aus GitHub anlegen

1. hPanel → **Websites → Website hinzufügen → Node.js-Web-App → Git-Repository importieren**.
2. **Mit GitHub verbinden** und der Hostinger-GitHub-App Zugriff auf `amplus-gmbh/pokertimer` geben. Das Repo gehört einer Organisation: Bei der Installation die Organisation `amplus-gmbh` wählen bzw. dort freigeben lassen.
3. Als Domain `pokertimer.geekz.ch` wählen. Liegt `geekz.ch` nicht bei Hostinger, beim DNS-Anbieter den von Hostinger angezeigten Eintrag für `pokertimer` setzen.
4. Build-Einstellungen prüfen:

| Einstellung | Wert |
| --- | --- |
| Framework | Express (bzw. „Andere“) |
| Branch | `main` |
| Node.js-Version | 22 oder 24 |
| Root-Verzeichnis | `/` |
| Build-Befehl | leer lassen |
| Entry-Datei | `server.js` |
| Paketmanager | npm |

5. Unter **Umgebungsvariablen** eintragen (ohne Anführungszeichen; `PORT` setzt Hostinger selbst):

| Variable | Wert |
| --- | --- |
| `NODE_ENV` | `production` |
| `DB_HOST` | `localhost` |
| `DB_PORT` | `3306` |
| `DB_NAME` | Datenbankname aus Schritt 1 |
| `DB_USER` | Datenbankbenutzer aus Schritt 1 |
| `DB_PASSWORD` | Datenbankpasswort aus Schritt 1 |

6. **Deploy** klicken. Danach SSL für `pokertimer.geekz.ch` aktivieren, falls hPanel das nicht automatisch tut.

### 3. Prüfen

`https://pokertimer.geekz.ch` öffnen. Oben rechts muss **„Mit MySQL verbunden“** stehen; „Nur temporär gespeichert“ heisst, dass DB-Variablen fehlen. Im Runtime-Log von hPanel erscheint beim Start `MySQL verbunden; …`. Die Tabelle `tournaments` wird beim ersten Start automatisch angelegt.

### Updates

Jeder Push auf `main` löst auf Hostinger automatisch Neuinstallation und Neustart aus. Geänderte Umgebungsvariablen werden erst nach einem erneuten Deploy bzw. Neustart wirksam.
