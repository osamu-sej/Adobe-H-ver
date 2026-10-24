"""試用・テスト用のサンプルPDF（架空のデータ）を public/sample.pdf に作る。

使い方: python3 scripts/make_sample.py
必要: reportlab, Pillow, IPAゴシック（fonts-ipafont-gothic）
"""

import io
import random
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont
from reportlab.lib.pagesizes import A4
from reportlab.lib.utils import ImageReader
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.pdfgen import canvas

FONT_PATH = "/usr/share/fonts/opentype/ipafont-gothic/ipag.ttf"
OUT = Path(__file__).resolve().parent.parent / "public" / "sample.pdf"

pdfmetrics.registerFont(TTFont("G", FONT_PATH))
W, H = A4
random.seed(7)


def text(c, x, y, s, size=10.5, color=(0.1, 0.1, 0.12)):
    c.setFillColorRGB(*color)
    c.setFont("G", size)
    c.drawString(x, H - y, s)


def rtext(c, x, y, s, size=10.5):
    c.setFillColorRGB(0.1, 0.1, 0.12)
    c.setFont("G", size)
    c.drawRightString(x, H - y, s)


def hline(c, x0, x1, y, width=0.6, gray=0.55):
    c.setStrokeColorRGB(gray, gray, gray)
    c.setLineWidth(width)
    c.line(x0, H - y, x1, H - y)


def invoice(c):
    c.setFillColorRGB(0.95, 0.96, 0.98)
    c.rect(0, H - 92, W, 92, stroke=0, fill=1)
    text(c, 48, 58, "請求書", 26)
    text(c, 400, 44, "請求番号：INV-2026-001234", 9.5)
    text(c, 400, 60, "請求日：2026年10月24日", 9.5)
    text(c, 400, 76, "お支払期限：2026/11/30", 9.5)

    text(c, 48, 130, "株式会社サンプル商事　御中", 14)
    hline(c, 48, 300, 136, 1, 0.2)
    text(c, 48, 160, "下記のとおりご請求申し上げます。", 10)

    text(c, 360, 128, "株式会社カクス物産", 11)
    text(c, 360, 145, "〒100-0001 東京都千代田区千代田1-1", 9)
    text(c, 360, 160, "TEL 03-1234-5678　FAX 03-1234-5679", 9)
    text(c, 360, 175, "担当：山田 太郎（携帯 090-1234-5678）", 9)
    text(c, 360, 190, "taro.yamada@example.co.jp", 9)

    c.setFillColorRGB(0.12, 0.16, 0.24)
    c.rect(48, H - 232, 499, 30, stroke=0, fill=1)
    text(c, 60, 222, "ご請求金額（税込）", 12, (1, 1, 1))
    c.setFillColorRGB(1, 1, 1)
    c.setFont("G", 16)
    c.drawRightString(535, H - 223, "¥1,234,567-")

    y = 262
    c.setFillColorRGB(0.93, 0.94, 0.96)
    c.rect(48, H - (y + 16), 499, 22, stroke=0, fill=1)
    text(c, 58, y + 8, "品名", 9.5)
    rtext(c, 330, y + 8, "数量", 9.5)
    rtext(c, 430, y + 8, "単価", 9.5)
    rtext(c, 535, y + 8, "金額", 9.5)
    rows = [
        ("業務委託費（10月分）", 1, 800000),
        ("システム保守料", 1, 150000),
        ("データ入力作業", 120, 1200),
        ("交通費実費", 1, 18334),
        ("資料印刷費", 300, 45),
    ]
    y += 34
    subtotal = 0
    for name, qty, price in rows:
        amount = qty * price
        subtotal += amount
        text(c, 58, y, name)
        rtext(c, 330, y, f"{qty:,}")
        rtext(c, 430, y, f"¥{price:,}")
        rtext(c, 535, y, f"¥{amount:,}")
        hline(c, 48, 547, y + 8, 0.4, 0.8)
        y += 26
    tax = 1234567 - subtotal
    y += 6
    for label, value in (("小計", subtotal), ("消費税（10%）", tax), ("合計", 1234567)):
        text(c, 380, y, label)
        rtext(c, 535, y, f"¥{value:,}")
        y += 20
    hline(c, 380, 547, y - 14, 1, 0.2)

    y += 20
    text(c, 48, y, "お振込先", 12)
    hline(c, 48, 547, y + 6, 0.6)
    y += 26
    for line in (
        "みどり銀行　本店営業部（店番 001）",
        "普通預金　口座番号 1234567",
        "口座名義　カ）カクスブッサン",
    ):
        text(c, 58, y, line)
        y += 19
    y += 14
    text(c, 48, y, "備考", 12)
    hline(c, 48, 547, y + 6, 0.6)
    y += 26
    for line in (
        "※ 振込手数料は貴社にてご負担ください。",
        "※ ご不明点は担当（090-1234-5678）までご連絡ください。",
        "※ 本書はテスト用の架空データです。実在の人物・団体とは関係ありません。",
    ):
        text(c, 58, y, line, 9.5)
        y += 18
    c.showPage()


def roster(c):
    text(c, 48, 60, "社員名簿（2026年10月1日現在）", 18)
    text(c, 48, 82, "取扱注意：社外への持ち出し禁止", 9.5, (0.75, 0.1, 0.1))
    cols = [(48, "社員番号"), (110, "氏名"), (190, "生年月日"), (275, "電話番号"), (380, "マイナンバー"), (482, "入社日")]
    y = 112
    c.setFillColorRGB(0.12, 0.16, 0.24)
    c.rect(44, H - (y + 16), 507, 22, stroke=0, fill=1)
    for x, label in cols:
        text(c, x, y + 8, label, 9, (1, 1, 1))
    names = [
        "佐藤 健一", "鈴木 美咲", "高橋 翔太", "田中 陽子", "伊藤 大輔", "渡辺 さくら",
        "山本 拓也", "中村 優花", "小林 直樹", "加藤 真由", "吉田 浩二", "山田 花子",
        "佐々木 隆", "山口 彩", "松本 亮", "井上 恵",
    ]
    y += 34
    for i, name in enumerate(names):
        if i % 2 == 1:
            c.setFillColorRGB(0.965, 0.97, 0.98)
            c.rect(44, H - (y + 13), 507, 22, stroke=0, fill=1)
        emp = f"E{10231 + i * 7:05d}"
        birth = f"{1972 + i * 2}/{(i * 5) % 12 + 1:02d}/{(i * 11) % 28 + 1:02d}"
        phone = f"090-{random.randint(1000, 9999)}-{random.randint(1000, 9999)}"
        if i == 4:
            phone = "090-1234-5678"
        mynum = f"{random.randint(1000, 9999)} {random.randint(1000, 9999)} {random.randint(1000, 9999)}"
        joined = f"{2005 + i}年{(i * 3) % 12 + 1}月1日"
        for (x, _), value in zip(cols, (emp, name, birth, phone, mynum, joined)):
            text(c, x, y + 6, value, 9)
        y += 22
    y += 20
    text(c, 48, y, "緊急連絡先：総務部 03-1234-5680（平日 9:00〜18:00）", 9.5)
    c.showPage()


def expenses(c):
    text(c, 48, 60, "経費精算書", 18)
    text(c, 48, 86, "申請者：山田 太郎　社員番号 E10259　所属：営業第二部", 10)
    text(c, 48, 104, "申請日：令和8年10月20日", 10)
    y = 140
    hline(c, 48, 547, y - 14, 1, 0.2)
    items = [
        ("2026/10/03", "タクシー代（顧客訪問）", 4280, "4980 1234 5678 9012"),
        ("2026/10/07", "新幹線（東京-大阪 往復）", 29440, "4980 1234 5678 9012"),
        ("2026/10/08", "宿泊費（大阪）", 12800, "4980 1234 5678 9012"),
        ("2026/10/15", "接待飲食費", 38500, "5241 0000 1111 2222"),
        ("2026/10/18", "書籍購入", 3520, "現金"),
    ]
    text(c, 48, y, "日付", 9.5)
    text(c, 130, y, "内容", 9.5)
    rtext(c, 380, y, "金額", 9.5)
    text(c, 400, y, "支払方法（カード番号）", 9.5)
    y += 24
    total = 0
    for d, what, amount, card in items:
        total += amount
        text(c, 48, y, d, 9.5)
        text(c, 130, y, what, 9.5)
        rtext(c, 380, y, f"{amount:,}円", 9.5)
        text(c, 400, y, card, 9.5)
        hline(c, 48, 547, y + 8, 0.4, 0.8)
        y += 24
    text(c, 300, y + 4, "合計", 11)
    rtext(c, 380, y + 4, f"{total:,}円", 11)
    y += 40
    text(c, 48, y, "振込先口座：みどり銀行 新宿支店 普通 7654321", 10)
    y += 20
    text(c, 48, y, "連絡先：090-1234-5678 / taro.yamada@example.co.jp", 10)
    c.showPage()


def scanned_receipt(c):
    """スキャンした領収書のような画像だけのページ（文字層なし）"""
    img = Image.new("RGB", (1240, 1754), (246, 243, 236))
    d = ImageDraw.Draw(img)
    big = ImageFont.truetype(FONT_PATH, 64)
    mid = ImageFont.truetype(FONT_PATH, 40)
    small = ImageFont.truetype(FONT_PATH, 30)
    d.text((470, 130), "領 収 書", font=big, fill=(30, 30, 35))
    d.line((180, 230, 1060, 230), fill=(60, 60, 60), width=3)
    d.text((180, 290), "山田 太郎 様", font=mid, fill=(30, 30, 35))
    d.text((180, 420), "金額", font=mid, fill=(30, 30, 35))
    d.text((380, 405), "¥ 38,500 -", font=big, fill=(20, 20, 25))
    d.line((360, 490, 1000, 490), fill=(60, 60, 60), width=2)
    d.text((180, 560), "但し 飲食代として", font=small, fill=(30, 30, 35))
    d.text((180, 640), "2026年10月15日 上記正に領収いたしました", font=small, fill=(30, 30, 35))
    d.text((180, 760), "カード番号 5241 **** **** 2222", font=small, fill=(30, 30, 35))
    d.text((180, 820), "承認番号 884213", font=small, fill=(30, 30, 35))
    d.text((640, 1000), "割烹 かくす庵", font=mid, fill=(30, 30, 35))
    d.text((640, 1060), "東京都中央区銀座0-0-0", font=small, fill=(30, 30, 35))
    d.text((640, 1110), "TEL 03-0000-1234", font=small, fill=(30, 30, 35))
    d.ellipse((950, 1150, 1080, 1280), outline=(200, 40, 40), width=6)
    d.text((975, 1190), "印", font=mid, fill=(200, 40, 40))
    img = img.rotate(0.6, resample=Image.BICUBIC, fillcolor=(246, 243, 236))
    img = img.filter(ImageFilter.GaussianBlur(0.6))
    px = img.load()
    for _ in range(30000):
        x, y = random.randrange(img.width), random.randrange(img.height)
        v = random.randint(-18, 18)
        r, g, b = px[x, y]
        px[x, y] = (max(0, min(255, r + v)), max(0, min(255, g + v)), max(0, min(255, b + v)))
    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=82)
    buf.seek(0)
    c.drawImage(ImageReader(buf), 0, 0, W, H)
    c.showPage()


def main():
    OUT.parent.mkdir(parents=True, exist_ok=True)
    c = canvas.Canvas(str(OUT), pagesize=A4)
    c.setTitle("請求書・社員名簿（サンプル）")
    c.setAuthor("山田 太郎")
    c.setSubject("テスト用の架空データ")
    invoice(c)
    roster(c)
    expenses(c)
    scanned_receipt(c)
    c.save()
    print(f"wrote {OUT}")


if __name__ == "__main__":
    main()
