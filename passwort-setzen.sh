#!/bin/bash
# Passwort eines Tool-Benutzers direkt auf dem Server setzen (14.09.2026).
#
# Zweck: Der einzige Weg zurueck, wenn jemand sein Passwort vergessen hat und
# nicht mehr angemeldet ist. Es gibt bewusst KEINEN Reset-Link per Mail und
# keine Hintertuer im Web (die gab es bis 07.09. und war ein Sicherheitsloch).
#
# Das Passwort wird verdeckt eingegeben, steht nie in der Shell-Historie, nie in
# der Prozessliste und nie im Klartext auf der Platte. Gespeichert wird nur der
# scrypt-Hash, mit denselben Parametern wie im Tool.
#
# Aufruf:   /opt/topg/passwort-setzen.sh <Name>
# Beispiel: /opt/topg/passwort-setzen.sh Sam
set -u
DATEI=/opt/topg/server/data/users.json
NAME="${1:-}"

if [ -z "$NAME" ]; then
  echo "Aufruf: $0 <Name>"
  echo
  echo "Vorhandene Konten:"
  python3 -c "
import json
for u in json.load(open('$DATEI')):
    print('  %-12s %-7s Passwort gesetzt: %s' % (u['name'], u['role'], 'ja' if u.get('pass') else 'NEIN (gesperrt)'))
"
  exit 1
fi

TREFFER=$(python3 -c "
import json,sys
u=[x for x in json.load(open('$DATEI')) if x['name'].lower()=='${NAME,,}']
print(u[0]['name'] if u else '')
")
if [ -z "$TREFFER" ]; then
  echo "Kein Konto mit dem Namen '$NAME'."
  exit 1
fi

echo "Neues Passwort für: $TREFFER"
echo "Mindestens 10 Zeichen. Die Eingabe bleibt unsichtbar."
printf "Neues Passwort: "; read -rs PW1; echo
printf "Wiederholen   : "; read -rs PW2; echo

if [ "$PW1" != "$PW2" ]; then echo "Die beiden Eingaben sind nicht gleich. Nichts geändert."; unset PW1 PW2; exit 1; fi
if [ "${#PW1}" -lt 10 ]; then echo "Zu kurz (${#PW1} Zeichen, nötig sind 10). Nichts geändert."; unset PW1 PW2; exit 1; fi

cp "$DATEI" "$DATEI.bak-$(date +%s)"

# Passwort geht ueber die Standardeingabe an node, nicht als Argument.
printf '%s' "$PW1" | node -e '
const fs=require("fs"), crypto=require("crypto");
let pw=""; process.stdin.on("data",d=>pw+=d); process.stdin.on("end",()=>{
  const datei=process.argv[1], name=process.argv[2];
  const salt=crypto.randomBytes(16).toString("hex");
  const dk=crypto.scryptSync(pw, salt, 64, {N:16384, r:8, p:1});
  const users=JSON.parse(fs.readFileSync(datei,"utf8"));
  const u=users.find(x=>x.name.toLowerCase()===name.toLowerCase());
  if(!u){ console.error("Benutzer verschwunden."); process.exit(1); }
  u.pass=`${salt}:${dk.toString("hex")}`;
  u.passChanged=new Date().toISOString();
  u.passSetBy="Terminal";
  fs.writeFileSync(datei+".tmp", JSON.stringify(users,null,2));
  fs.renameSync(datei+".tmp", datei);
  console.log("Passwort für "+u.name+" gesetzt.");
});
' "$DATEI" "$TREFFER" || { echo "Fehlgeschlagen, Sicherung liegt daneben."; unset PW1 PW2; exit 1; }
unset PW1 PW2

# Alle Sitzungen dieses Benutzers beenden, damit das neue Passwort sofort gilt.
python3 -c "
import json,os
users=json.load(open('$DATEI'))
uid=next(x['id'] for x in users if x['name']=='$TREFFER')
p='/opt/topg/server/data/sessions.json'
s=json.load(open(p))
weg=[k for k,v in s.items() if v.get('userId')==uid]
for k in weg: del s[k]
json.dump(s, open(p+'.tmp','w')); os.replace(p+'.tmp', p)
print('  %d bestehende Sitzung(en) beendet.' % len(weg))
"
echo
echo "Fertig. Anmelden unter https://topg.leichtkraut.de/login mit dem Namen $TREFFER."
