# Icon NKScanpdf — cùng họ với icon NKPdf (tờ giấy gập góc viền xanh, chữ tím, "NK" xanh),
# thêm: khung ngắm 4 góc màu tím ôm lấy tờ giấy + tia quét vàng phát sáng cắt ngang.
# Chạy: python tools/tao_icon.py  -> icons/*.png
import os
from PIL import Image, ImageDraw, ImageFilter, ImageFont

GOC = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FONT = os.path.join(GOC, "fonts", "BeVietnamPro-Black.ttf")
FONT_NK = os.path.join(GOC, "fonts", "BeVietnamPro-Bold.ttf")
XANH = (31, 95, 191, 255)
XANH_GAP = (196, 219, 247, 255)
TIM = (112, 40, 214, 255)
XANH_NK = (31, 79, 160, 255)
VANG = (242, 196, 109, 255)
VANG_DAM = (224, 169, 62, 255)
DONG = (156, 183, 221, 255)


def chu_vua(d, chu, font_file, rong, cao):
    co = max(4, int(cao * 1.6))
    while co > 4:
        f = ImageFont.truetype(font_file, co)
        bb = d.textbbox((0, 0), chu, font=f)
        if bb[2] - bb[0] <= rong and bb[3] - bb[1] <= cao:
            return f, bb
        co -= 1
    f = ImageFont.truetype(font_file, 4)
    return f, d.textbbox((0, 0), chu, font=f)


def ve(n, nen=None, ti_le=1.0):
    S = n * 4  # vẽ to rồi thu nhỏ cho mịn
    img = Image.new("RGBA", (S, S), nen or (0, 0, 0, 0))
    lop = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(lop)
    k = S * ti_le
    o = (S - k) / 2
    P = lambda v: o + v * k  # noqa: E731

    # --- khung ngắm 4 góc (tím) ---
    m, L, t = 0.05, 0.20, k / 22
    for (cx, cy, sx, sy) in [(m, m, 1, 1), (1 - m, m, -1, 1), (1 - m, 1 - m, -1, -1), (m, 1 - m, 1, -1)]:
        x, y = P(cx), P(cy)
        d.line([(x, y + sy * L * k), (x, y), (x + sx * L * k, y)], fill=TIM, width=round(t), joint="curve")
        for (px, py) in [(x, y + sy * L * k), (x + sx * L * k, y), (x, y)]:
            d.ellipse([px - t / 2, py - t / 2, px + t / 2, py + t / 2], fill=TIM)

    # --- tờ giấy gập góc (giống NKPdf) ---
    x0, y0, x1, y1 = P(0.22), P(0.15), P(0.78), P(0.85)
    gap = k * 0.15
    w = round(k / 36)
    vo = [(x0, y0), (x1 - gap, y0), (x1, y0 + gap), (x1, y1), (x0, y1)]
    d.polygon(vo, fill=(255, 255, 255, 255))
    d.polygon([(x1 - gap, y0), (x1 - gap, y0 + gap), (x1, y0 + gap)], fill=XANH_GAP)

    # vệt sáng quét (vàng nhạt, mờ dần lên trên tia quét)
    tia_y = P(0.60)
    vet = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    vd = ImageDraw.Draw(vet)
    cao_vet = k * 0.20
    for i in range(int(cao_vet)):
        a = int(110 * (1 - i / cao_vet) ** 1.6)
        vd.line([(x0, tia_y - i), (x1, tia_y - i)], fill=(255, 214, 120, a))
    lop = Image.alpha_composite(lop, vet)
    d = ImageDraw.Draw(lop)

    # dòng chữ đã quét (phía trên)
    lw = round(k / 40)
    for yy, x_end in [(0.25, 0.56), (0.31, 0.62)]:
        d.line([(P(0.30), P(yy)), (P(x_end), P(yy))], fill=DONG, width=lw)
    # chữ SCAN tím
    f, bb = chu_vua(d, "SCAN", FONT, (x1 - x0) * 0.80, k * 0.13)
    cy = P(0.45)
    d.text(((x0 + x1) / 2 - (bb[2] - bb[0]) / 2 - bb[0], cy - (bb[3] - bb[1]) / 2 - bb[1]), "SCAN", font=f, fill=TIM)
    # NK xanh phía dưới
    f2, bb2 = chu_vua(d, "NK", FONT_NK, (x1 - x0) * 0.40, k * 0.09)
    cy2 = P(0.74)
    d.text(((x0 + x1) / 2 - (bb2[2] - bb2[0]) / 2 - bb2[0], cy2 - (bb2[3] - bb2[1]) / 2 - bb2[1]), "NK",
           font=f2, fill=XANH_NK)

    # viền giấy
    d.line(vo + [vo[0]], fill=XANH, width=w, joint="curve")
    d.line([(x1 - gap, y0), (x1 - gap, y0 + gap), (x1, y0 + gap)], fill=XANH, width=w)

    # --- tia quét vàng phát sáng, vượt ra ngoài tờ giấy ---
    sang = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    sd = ImageDraw.Draw(sang)
    sd.line([(P(0.10), tia_y), (P(0.90), tia_y)], fill=(255, 200, 80, 230), width=round(k / 16))
    sang = sang.filter(ImageFilter.GaussianBlur(k / 40))
    lop = Image.alpha_composite(lop, sang)
    d = ImageDraw.Draw(lop)
    tw = round(k / 42)
    d.line([(P(0.12), tia_y), (P(0.88), tia_y)], fill=VANG_DAM, width=tw)
    d.line([(P(0.14), tia_y), (P(0.86), tia_y)], fill=(255, 236, 180, 255), width=max(1, tw // 3))

    img = Image.alpha_composite(img, lop)
    return img.resize((n, n), Image.LANCZOS)


if __name__ == "__main__":
    ra = os.path.join(GOC, "icons")
    os.makedirs(ra, exist_ok=True)
    ve(192).save(os.path.join(ra, "icon-192.png"))
    ve(512).save(os.path.join(ra, "icon-512.png"))
    ve(64).save(os.path.join(ra, "icon-64.png"))
    # maskable / apple: nền trắng xanh, thu nhỏ vào vùng an toàn
    ve(512, (255, 255, 255, 255), 0.78).save(os.path.join(ra, "maskable-512.png"))
    ve(180, (255, 255, 255, 255), 0.86).save(os.path.join(ra, "apple-180.png"))
    print("Da tao icon trong", ra)
