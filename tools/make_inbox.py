"""Build the fictional sample inbox used by the InboxLedger demo.

Creates one extra invoice PDF whose printed total is wrong on purpose (to show the
math check) and six .eml files. All companies, people and addresses are invented,
and every domain uses the reserved .example TLD.
"""
import json
import subprocess
from decimal import Decimal, ROUND_HALF_UP
from email.message import EmailMessage
from email.utils import format_datetime
from datetime import datetime, timezone, timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
ATT = ROOT / "samples" / "attachments"
INBOX = ROOT / "samples" / "inbox"
D = lambda x: Decimal(str(x))
r2 = lambda x: D(x).quantize(Decimal("0.01"), ROUND_HALF_UP)
de = lambda x: f"{r2(x):,.2f}".replace(",", "X").replace(".", ",").replace("X", ".")

# ---- invoice with a deliberate addition error ----
items = [("Druckerpapier A4, 80 g, 5x500 Blatt", 6, "Karton", 24.90),
         ("Toner schwarz, kompatibel TN-2420", 3, "Stk", 38.50),
         ("Ordner breit, 8 cm, blau", 20, "Stk", 2.45),
         ("Kugelschreiber, 50er Pack", 2, "Pack", 11.90)]
net_true = sum(r2(D(q) * D(p)) for _, q, _, p in items)
net_printed = net_true + D("10.00")            # the supplier's own addition mistake
vat = r2(net_printed * D("0.19"))
total = net_printed + vat
rows = "".join(f"<tr><td>{d}</td><td class=r>{q}</td><td>{u}</td><td class=r>{de(p)}</td><td class=r>{de(D(q)*D(p))}</td></tr>"
               for d, q, u, p in items)
html = f"""<html><head><meta charset=utf-8><style>
body{{margin:0}} .p{{width:794px;height:1123px;padding:60px 70px;box-sizing:border-box;font:13px/1.5 'DejaVu Sans',sans-serif;color:#222;position:relative}}
h1{{font-size:26px;color:#1d4e89;margin:0}} .m{{position:absolute;top:24px;right:30px;font:700 11px sans-serif;letter-spacing:.2em;color:#c33;border:1.5px solid #c33;padding:4px 8px;transform:rotate(4deg)}}
table{{border-collapse:collapse;width:100%;margin-top:26px}} th,td{{padding:7px 8px;text-align:left;border-bottom:1px solid #ddd}} th{{background:#eef3f9}} .r{{text-align:right}}
.s{{width:300px;margin:16px 0 0 auto}} .s td{{border:none;padding:4px 8px}} .s tr:last-child td{{font-weight:700;border-top:2px solid #1d4e89}}
</style></head><body><div class=p><div class=m>SAMPLE</div>
<h1>Nordlicht Bürobedarf GmbH</h1><div style="color:#555">Mainufer 3 · 63739 Aschaffenburg · info@nordlicht-buero.example</div>
<div style="display:flex;justify-content:space-between;margin-top:40px"><div>Brandt Haustechnik e.K.<br>Lindenallee 23<br>63768 Hösbach</div>
<div>Rechnungsnr.: <b>NL-55821</b><br>Datum: 22.10.2026<br>Fällig: 05.11.2026</div></div>
<h2 style="margin:36px 0 0;font-size:20px">Rechnung</h2>
<table><tr><th>Artikel</th><th class=r>Menge</th><th>Einheit</th><th class=r>Preis €</th><th class=r>Summe €</th></tr>{rows}</table>
<table class=s><tr><td>Netto</td><td class=r>{de(net_printed)} €</td></tr><tr><td>MwSt. 19 %</td><td class=r>{de(vat)} €</td></tr><tr><td>Gesamt</td><td class=r>{de(total)} €</td></tr></table>
<p style="margin-top:30px">Zahlbar bis 05.11.2026 ohne Abzug. IBAN DE00 0000 0000 0000 0000 00</p></div></body></html>"""
(ATT / "invoice-nordlicht.html").write_text(html)
subprocess.run(["node", "-e", f"""
const {{chromium}}=require('playwright');(async()=>{{const b=await chromium.launch();const p=await b.newPage();
await p.goto('file://{ATT}/invoice-nordlicht.html');await p.pdf({{path:'{ATT}/invoice-nordlicht.pdf',width:'794px',height:'1123px',printBackground:true}});
await p.screenshot({{path:'{ATT}/invoice-nordlicht.png'}});await b.close();}})()"""], check=True)
(ATT / "invoice-nordlicht.html").unlink()

# ---- the inbox ----
base = datetime(2026, 10, 28, 7, 30, tzinfo=timezone(timedelta(hours=1)))
mails = [
    dict(id="m1", sender="Kessler Rohr & Armatur <rechnung@kessler-rohr.example>", subject="Rechnung RE-2026-04187",
         body="Guten Tag,\n\nanbei erhalten Sie unsere Rechnung RE-2026-04187.\n\nMit freundlichen Grüßen\nKessler Rohr & Armatur GmbH",
         files=["invoice-de.pdf"], minutes=0),
    dict(id="m2", sender="Herbst-Aktion <newsletter@werkzeugwelt.example>", subject="Nur diese Woche: 20 % auf Akkuschrauber",
         body="Entdecken Sie unsere Herbstangebote! Jetzt im Shop.", files=[], minutes=41),
    dict(id="m3", sender="Bluegate Billing <billing@bluegate.example>", subject="Invoice BG-10442 from Bluegate Office Supply",
         body="Hi,\n\nplease find invoice BG-10442 attached. Payment is due within 30 days.\n\nThanks,\nBluegate Billing",
         files=["invoice-us.pdf"], minutes=95),
    dict(id="m4", sender="Jonas Brandt <jonas@brandt-haustechnik.example>", subject="Beleg Baumarkt (Bohrmaschine)",
         body="Hi, hier der Kassenbon vom Baumarkt für die neue Bohrmaschine. Bar bezahlt.\nJonas",
         files=["receipt-photo.jpg"], minutes=180),
    dict(id="m5", sender="Nordlicht Bürobedarf <info@nordlicht-buero.example>", subject="Ihre Rechnung NL-55821",
         body="Sehr geehrte Damen und Herren,\n\nanbei die Rechnung zu Ihrer Bestellung.\n\nNordlicht Bürobedarf GmbH",
         files=["invoice-nordlicht.pdf"], minutes=260),
    dict(id="m6", sender="Kessler Rohr & Armatur <rechnung@kessler-rohr.example>", subject="Erinnerung: Rechnung RE-2026-04187",
         body="Guten Tag,\n\nwir erlauben uns, Sie an unsere Rechnung RE-2026-04187 zu erinnern. Die Rechnung finden Sie erneut im Anhang.\n\nKessler Rohr & Armatur GmbH",
         files=["invoice-de.pdf"], minutes=1500),
]
types = {".pdf": ("application", "pdf"), ".jpg": ("image", "jpeg"), ".png": ("image", "png")}
for m in mails:
    msg = EmailMessage()
    msg["From"] = m["sender"]; msg["To"] = "buchhaltung@brandt-haustechnik.example"
    msg["Subject"] = m["subject"]; msg["Date"] = format_datetime(base + timedelta(minutes=m["minutes"]))
    msg["Message-ID"] = f"<{m['id']}@inboxledger.example>"
    msg.set_content(m["body"])
    for f in m["files"]:
        mt, st = types[Path(f).suffix]
        msg.add_attachment((ATT / f).read_bytes(), maintype=mt, subtype=st, filename=f)
    (INBOX / f"{m['id']}.eml").write_bytes(bytes(msg))

json.dump({"nordlicht": {"net_printed": float(net_printed), "net_lines": float(net_true), "vat": float(vat), "total": float(total)}},
          open(ROOT / "samples" / "truth.json", "w"), indent=2)
print("net lines", net_true, "printed", net_printed, "vat", vat, "total", total)
