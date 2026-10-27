"""
POV39 Timeline V2 compositor.

Reads a render plan that the worker has already validated (src/render/timelineV2.js and
src/render/renderV2.js) and writes raw RGB24 frames to stdout, which the worker pipes
straight into its own FFmpeg encoder. It never builds a shell command and never reads a
path or a URL from the timeline itself: every file it opens was named by the worker.

Per frame, in order:
  1. the program picture: the active clip (or black), with its transition — fade from
     black, dissolve from the outgoing clip's continuing footage, or slide over it;
  2. speaker zoom: a punch-in crop of that picture around the face anchor — the source
     video itself is transformed, not an overlay;
  3. image cards, with the program picture blurred and dimmed behind them;
  4. text overlays (lower thirds, pills, headlines, quotes, stamps, credits).

Memory is bounded: one decoded frame per open clip (at most two during a transition),
plus cached overlay sprites. Nothing is held for the length of the video.

  python3 compose.py plan.json                      # frames to stdout
  python3 compose.py plan.json --preview 1.5,9 DIR  # JPEG stills of those timestamps
  python3 compose.py --self-check                   # prints Pillow / RTL support as JSON
"""
import json
import math
import os
import subprocess
import sys

from PIL import Image, ImageDraw, ImageFilter, ImageFont, features

FFMPEG = os.environ.get("FFMPEG_BIN") or "ffmpeg"
RAQM = features.check("raqm")
Image.MAX_IMAGE_PIXELS = 60_000_000  # a decompression bomb is refused, not decoded

INK = (12, 14, 20)
WHITE = (255, 255, 255)

# ---------------------------------------------------------------- easing / timing


def clamp01(t):
    return 0.0 if t <= 0 else 1.0 if t >= 1 else t


def ease_out_cubic(t):
    t = clamp01(t)
    return 1 - (1 - t) ** 3


def ease_in_out(t):
    t = clamp01(t)
    return t * t * (3 - 2 * t)


CURVES = {"easeOutCubic": ease_out_cubic, "easeInOut": ease_in_out, "linear": clamp01}


def envelope(ov, T):
    """(entrance 0..1, exit 1..0, seconds since start) for an overlay at time T."""
    t = T - ov["start"]
    span = ov["end"] - ov["start"]
    curve = CURVES.get(ov.get("curve"), ease_out_cubic)
    enter = curve(t / ov["animation"])
    out_len = min(0.3, ov["animation"], span / 3)
    leave = 1 - ease_in_out((T - (ov["end"] - out_len)) / out_len)
    return enter, leave, t


# ---------------------------------------------------------------- fonts / text

FONT_CANDIDATES = {
    "display": [
        "/usr/share/fonts/truetype/noto/NotoSans-CondensedBold.ttf",
        "/usr/share/fonts/truetype/noto/NotoSans-Bold.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSansCondensed-Bold.ttf",
        "C:/Windows/Fonts/bahnschrift.ttf",
        "C:/Windows/Fonts/arialbd.ttf",
    ],
    "sans": [
        "/usr/share/fonts/truetype/noto/NotoSans-Medium.ttf",
        "/usr/share/fonts/truetype/noto/NotoSans-Regular.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
        "C:/Windows/Fonts/segoeui.ttf",
        "C:/Windows/Fonts/arial.ttf",
    ],
    "serif": [
        "/usr/share/fonts/truetype/noto/NotoSerif-Bold.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSerif-Bold.ttf",
        "C:/Windows/Fonts/georgiab.ttf",
        "C:/Windows/Fonts/timesbd.ttf",
    ],
    "serif_italic": [
        "/usr/share/fonts/truetype/noto/NotoSerif-Italic.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSerif-Italic.ttf",
        "C:/Windows/Fonts/georgiai.ttf",
        "C:/Windows/Fonts/timesi.ttf",
    ],
    "hebrew": [
        "/usr/share/fonts/truetype/noto/NotoSansHebrew-Bold.ttf",
        "/usr/share/fonts/truetype/noto/NotoSansHebrew-Regular.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
        "C:/Windows/Fonts/arialbd.ttf",
    ],
}


def first_existing(paths):
    for p in paths:
        if p and os.path.isfile(p):
            return p
    return None


def is_rtl_char(ch):
    o = ord(ch)
    return 0x0590 <= o <= 0x08FF or 0xFB1D <= o <= 0xFEFC


def has_rtl(s):
    return any(is_rtl_char(c) for c in s)


def visual(s):
    """Visual order for RTL text when Pillow has no raqm (no BiDi engine): runs of
    Hebrew/Arabic are reversed and the run order flipped; Latin and digits stay readable."""
    if RAQM or not has_rtl(s):
        return s
    # Runs of strong characters (True = RTL, False = LTR) and neutrals (None).
    runs = []
    for ch in s:
        kind = None if (ch.isspace() or ch in ".,:;!?\"'()-–—") else is_rtl_char(ch)
        if runs and runs[-1][1] == kind:
            runs[-1][0] += ch
        else:
            runs.append([ch, kind])
    # A neutral between two runs of one direction takes it; otherwise the paragraph's (RTL).
    for i, run in enumerate(runs):
        if run[1] is None:
            before = next((r[1] for r in reversed(runs[:i]) if r[1] is not None), None)
            after = next((r[1] for r in runs[i + 1:] if r[1] is not None), None)
            run[1] = before if before is not None and before == after else True
    merged = []
    for text, rtl in runs:
        if merged and merged[-1][1] == rtl:
            merged[-1][0] += text
        else:
            merged.append([text, rtl])
    return "".join(t[::-1] if rtl else t for t, rtl in reversed(merged))


class Fonts:
    """font_id → file comes from the worker (fontManager); otherwise a role default.
    Every substitution is recorded so the job report says which font was really used."""

    def __init__(self, resolved):
        self.resolved = {k: v for k, v in (resolved or {}).items() if v and os.path.isfile(v)}
        self.cache = {}
        self.used = {}

    def role_for(self, font_id, default):
        f = (font_id or "").lower()
        if "playfair" in f or "serif" in f:
            return "serif_italic" if default == "serif_italic" else "serif"
        if "inter" in f or "regular" in f or "sans" in f:
            return "sans" if default != "display" or "bold" not in f else "display"
        if "oswald" in f or "bold" in f or "condensed" in f:
            return "display"
        return default

    def get(self, font_id, default_role, size, text=""):
        size = max(8, int(size))
        path = self.resolved.get(font_id) if font_id else None
        role = "hebrew" if has_rtl(text) and not path else self.role_for(font_id, default_role)
        if not path:
            path = first_existing(FONT_CANDIDATES[role]) or first_existing(FONT_CANDIDATES["sans"])
        key = (path, size)
        if key not in self.cache:
            layout = ImageFont.Layout.RAQM if RAQM else ImageFont.Layout.BASIC
            self.cache[key] = ImageFont.truetype(path, size, layout_engine=layout) if path else ImageFont.load_default(size)
        self.used[font_id or f"<{default_role}>"] = os.path.basename(path) if path else "pillow-default"
        return self.cache[key]


def text_w(draw, s, font):
    b = draw.textbbox((0, 0), s, font=font)
    return b[2] - b[0]


def wrap(draw, s, font, max_w, max_lines=4):
    words, lines, cur = s.split(), [], ""
    for w in words:
        trial = (cur + " " + w).strip()
        if text_w(draw, visual(trial), font) <= max_w or not cur:
            cur = trial
        else:
            lines.append(cur)
            cur = w
    if cur:
        lines.append(cur)
    if len(lines) > max_lines:
        lines = lines[:max_lines]
        lines[-1] = lines[-1].rstrip(".,") + "…"
    return [visual(line) for line in lines]


def hex_rgb(h):
    h = (h or "#d21428").lstrip("#")
    return tuple(int(h[i:i + 2], 16) for i in (0, 2, 4))


def readable_on(rgb):
    lum = 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]
    return INK if lum > 160 else WHITE


def with_alpha(sprite, k):
    """Sprite with its alpha multiplied by k (0..1)."""
    if k >= 0.999:
        return sprite
    out = sprite.copy()
    a = out.getchannel("A").point([int(v * k) for v in range(256)])
    out.putalpha(a)
    return out


# ---------------------------------------------------------------- overlay sprites


class Overlays:
    def __init__(self, plan, fonts):
        self.W, self.H = plan["width"], plan["height"]
        self.s = self.W / 1080.0
        self.fonts = fonts
        self.sprites = {}
        self.images = {}
        self.image_paths = plan.get("images", {})
        self.margin = int(40 * self.s)

    # Position a sprite whose centre is (x, y) relative, kept fully inside the frame.
    def place(self, ov, w, h, dy=0):
        cx, cy = ov["x"] * self.W, ov["y"] * self.H
        x = int(min(max(cx - w / 2, self.margin), self.W - self.margin - w))
        y = int(min(max(cy - h / 2, self.margin), self.H - self.margin - h)) + int(dy)
        return x, y

    def font(self, ov, role, size, text=""):
        return self.fonts.get(ov.get("font_id"), role, size * self.s, text)

    # -- lower third: accent bar, white title band, ink sub-line band (reference render7)
    def lower_third_parts(self, ov):
        key = ov["id"]
        if key in self.sprites:
            return self.sprites[key]
        s = self.s
        probe = ImageDraw.Draw(Image.new("L", (1, 1)))
        ft = self.font(ov, "display", 64, ov["title"])
        fs = self.fonts.get("", "sans", 36 * s, ov["subtitle"])
        title, sub = visual(ov["title"]), visual(ov["subtitle"])
        inner = max(text_w(probe, title, ft), text_w(probe, sub, fs) if sub else 0) + int(90 * s)
        w = int(min(inner, ov["width"], self.W - 2 * self.margin))
        bar, top, low = int(14 * s), int(104 * s), int(64 * s) if sub else 0
        h = top + low
        accent = hex_rgb(ov["accent"])
        band = Image.new("RGBA", (w, h), (0, 0, 0, 0))
        d = ImageDraw.Draw(band)
        d.rectangle([0, 0, bar, h], fill=accent + (255,))
        d.rectangle([bar, 0, w, top], fill=(255, 255, 255, 242))
        if sub:
            d.rectangle([bar, top, w, h], fill=INK + (235,))
        text = Image.new("RGBA", (w, h), (0, 0, 0, 0))
        d = ImageDraw.Draw(text)
        d.text((bar + int(36 * s), top // 2), title, font=ft, fill=INK + (255,), anchor="lm")
        if sub:
            d.text((bar + int(36 * s), top + low // 2), sub, font=fs, fill=(255, 255, 255, 255), anchor="lm")
        self.sprites[key] = (band, text, w, h, bar, top)
        return self.sprites[key]

    def lower_third(self, canvas, ov, T):
        enter, leave, t = envelope(ov, T)
        if enter <= 0 or leave <= 0:
            return
        band, text, w, h, bar, top = self.lower_third_parts(ov)
        x, y = self.place(ov, w, h)
        a = ov["animation"]
        wipe = int(bar + (w - bar) * enter)
        sub_wipe = int(bar + (w - bar) * CURVES[ov["curve"]]((t - 0.15 * a) / a))
        layer = Image.new("RGBA", (w, h), (0, 0, 0, 0))
        layer.paste(band.crop((0, 0, wipe, top)), (0, 0))
        if h > top and sub_wipe > bar:
            layer.paste(band.crop((0, top, sub_wipe, h)), (0, top))
        txt_k = ease_out_cubic((t - 0.55 * a) / (0.6 * a))
        if txt_k > 0:
            clip = Image.new("RGBA", (w, h), (0, 0, 0, 0))
            clip.paste(text.crop((0, 0, wipe, h)), (0, 0))
            layer.alpha_composite(with_alpha(clip, txt_k))
        canvas.alpha_composite(with_alpha(layer, leave), (x, y))

    # -- pill: one emphasised phrase on an accent block, rising into place
    def pill(self, canvas, ov, T):
        enter, leave, _ = envelope(ov, T)
        k = enter * leave
        if k <= 0:
            return
        key = ov["id"]
        if key not in self.sprites:
            f = self.font(ov, "display", 84, ov["title"])
            probe = ImageDraw.Draw(Image.new("L", (1, 1)))
            label = visual(ov["title"])
            tw = min(text_w(probe, label, f), ov["width"] - int(68 * self.s))
            if text_w(probe, label, f) > tw:  # shrink to fit the requested width
                f = self.font(ov, "display", 84 * tw / text_w(probe, label, f), ov["title"])
            pad = int(34 * self.s)
            h = int(f.size * 1.36)
            w = text_w(probe, label, f) + 2 * pad
            accent = hex_rgb(ov["accent"])
            sp = Image.new("RGBA", (w, h), (0, 0, 0, 0))
            d = ImageDraw.Draw(sp)
            d.rectangle([0, 0, w, h], fill=accent + (240,))
            d.text((w // 2, h // 2), label, font=f, fill=readable_on(accent) + (255,), anchor="mm")
            self.sprites[key] = sp
        sp = self.sprites[key]
        x, y = self.place(ov, sp.width, sp.height, dy=30 * self.s * (1 - enter))
        canvas.alpha_composite(with_alpha(sp, k), (x, y))

    # -- credit: small attribution tag (reference credit())
    def credit(self, canvas, ov, T):
        enter, leave, _ = envelope(ov, T)
        k = enter * leave
        if k <= 0:
            return
        key = ov["id"]
        if key not in self.sprites:
            label = ov["text"] or ov["citation"]
            f = self.font(ov, "sans", 26, label)
            probe = ImageDraw.Draw(Image.new("L", (1, 1)))
            lines = wrap(probe, label, f, ov["width"] - int(30 * self.s), max_lines=2)
            lh = int(f.size * 1.3)
            w = max(text_w(probe, line, f) for line in lines) + int(30 * self.s)
            h = lh * len(lines) + int(20 * self.s)
            sp = Image.new("RGBA", (w, h), (0, 0, 0, 0))
            d = ImageDraw.Draw(sp)
            d.rounded_rectangle([0, 0, w - 1, h - 1], int(10 * self.s), fill=(0, 0, 0, 150))
            for i, line in enumerate(lines):
                d.text((int(15 * self.s), int(10 * self.s) + i * lh), line, font=f, fill=(255, 255, 255, 225))
            self.sprites[key] = sp
        sp = self.sprites[key]
        x, y = self.place(ov, sp.width, sp.height)
        canvas.alpha_composite(with_alpha(sp, k), (x, y))

    # -- headline: large wrapped statement with a growing accent rule
    def headline(self, canvas, ov, T):
        enter, leave, _ = envelope(ov, T)
        k = enter * leave
        if k <= 0:
            return
        key = ov["id"]
        if key not in self.sprites:
            f = self.font(ov, "display", 96, ov["title"])
            probe = ImageDraw.Draw(Image.new("L", (1, 1)))
            max_w = min(ov["width"], self.W - 2 * self.margin)
            lines = wrap(probe, ov["title"], f, max_w - int(20 * self.s), max_lines=3)
            lh = int(f.size * 1.12)
            stroke = max(2, int(5 * self.s))
            w = max_w
            rule = int(14 * self.s)
            h = lh * len(lines) + rule + int(36 * self.s)
            sp = Image.new("RGBA", (w, h), (0, 0, 0, 0))
            d = ImageDraw.Draw(sp)
            for i, line in enumerate(lines):
                d.text((w // 2, i * lh + lh // 2), line, font=f, fill=(255, 255, 255, 255), anchor="mm",
                       stroke_width=stroke, stroke_fill=(0, 0, 0, 200))
            self.sprites[key] = (sp, w, h, rule, hex_rgb(ov["accent"]))
        sp, w, h, rule, accent = self.sprites[key]
        x, y = self.place(ov, w, h, dy=40 * self.s * (1 - enter))
        layer = sp.copy()
        bar_w = int(w * 0.6 * enter)
        if bar_w > 0:
            ImageDraw.Draw(layer).rectangle([w // 2 - bar_w // 2, h - rule, w // 2 + bar_w // 2, h], fill=accent + (255,))
        canvas.alpha_composite(with_alpha(layer, k), (x, y))

    # -- quote: dark card, accent quotation mark, serif body, attribution
    def quote(self, canvas, ov, T):
        enter, leave, _ = envelope(ov, T)
        k = enter * leave
        if k <= 0:
            return
        key = ov["id"]
        if key not in self.sprites:
            s = self.s
            w = int(min(ov["width"], self.W - 2 * self.margin))
            pad = int(56 * s)
            f = self.font(ov, "serif_italic", 54, ov["text"])
            fa = self.fonts.get("", "sans", 32 * s, ov["citation"] or ov["subtitle"])
            probe = ImageDraw.Draw(Image.new("L", (1, 1)))
            lines = wrap(probe, ov["text"], f, w - 2 * pad, max_lines=6)
            lh = int(f.size * 1.3)
            mark = int(140 * s)
            who = ov["citation"] or ov["subtitle"]
            h = pad + mark // 2 + lh * len(lines) + (int(70 * s) if who else 0) + pad
            accent = hex_rgb(ov["accent"])
            sp = Image.new("RGBA", (w, h), (0, 0, 0, 0))
            d = ImageDraw.Draw(sp)
            d.rounded_rectangle([0, 0, w - 1, h - 1], int(26 * s), fill=(10, 12, 18, 225))
            d.rectangle([0, int(26 * s), int(10 * s), h - int(26 * s)], fill=accent + (255,))
            d.text((pad, pad - int(30 * s)), "\u201c", font=self.fonts.get("", "serif", mark), fill=accent + (255,))
            y = pad + mark // 2
            for i, line in enumerate(lines):
                d.text((pad, y + i * lh), line, font=f, fill=(255, 255, 255, 255))
            if who:
                d.text((pad, y + len(lines) * lh + int(24 * s)), visual("\u2014 " + who), font=fa, fill=(200, 205, 215, 255))
            self.sprites[key] = sp
        sp = self.sprites[key]
        z = 0.94 + 0.06 * enter
        scaled = sp.resize((max(1, int(sp.width * z)), max(1, int(sp.height * z))), Image.BILINEAR) if z < 0.999 else sp
        x, y = self.place(ov, scaled.width, scaled.height)
        canvas.alpha_composite(with_alpha(scaled, k), (x, y))

    # -- stamp: rotated outlined block that lands with a scale-down (reference stamp());
    #    with both text and replacement, the text is struck through above the stamp.
    def stamp(self, canvas, ov, T):
        enter, leave, t = envelope(ov, T)
        land = ease_out_cubic(t / min(0.22, ov["animation"]))
        k = land * leave
        if k <= 0:
            return
        key = ov["id"]
        if key not in self.sprites:
            s = self.s
            label = ov["replacement"] or ov["text"]
            struck = ov["text"] if ov["replacement"] and ov["text"] else ""
            f = self.font(ov, "display", 120, label)
            probe = ImageDraw.Draw(Image.new("L", (1, 1)))
            shown = visual(label)
            tw = text_w(probe, shown, f)
            limit = min(ov["width"], self.W - 2 * self.margin) - int(120 * s)
            if tw > limit:
                f = self.font(ov, "display", 120 * limit / tw, label)
                tw = text_w(probe, shown, f)
            accent = hex_rgb(ov["accent"])
            box = Image.new("RGBA", (tw + int(120 * s), int(f.size * 1.55)), (0, 0, 0, 0))
            d = ImageDraw.Draw(box)
            d.rectangle([10, 10, box.width - 10, box.height - 10], outline=accent + (255,), width=max(4, int(12 * s)),
                        fill=(255, 255, 255, 225))
            d.text((box.width / 2, box.height / 2), shown, font=f, fill=accent + (255,), anchor="mm")
            box = box.rotate(-6, expand=True, resample=Image.BICUBIC)
            if struck:
                fs = self.font(ov, "display", 64, struck)
                sw = text_w(probe, visual(struck), fs)
                top = Image.new("RGBA", (max(box.width, sw + 20), int(fs.size * 1.5)), (0, 0, 0, 0))
                d = ImageDraw.Draw(top)
                d.text((top.width / 2, top.height / 2), visual(struck), font=fs, fill=(255, 255, 255, 255), anchor="mm",
                       stroke_width=3, stroke_fill=(0, 0, 0, 200))
                d.line([(top.width / 2 - sw / 2, top.height / 2), (top.width / 2 + sw / 2, top.height / 2)],
                       fill=accent + (255,), width=max(3, int(8 * s)))
                both = Image.new("RGBA", (max(top.width, box.width), top.height + box.height), (0, 0, 0, 0))
                both.alpha_composite(top, ((both.width - top.width) // 2, 0))
                both.alpha_composite(box, ((both.width - box.width) // 2, top.height))
                box = both
            self.sprites[key] = box
        sp = self.sprites[key]
        z = 1.3 - 0.3 * land
        scaled = sp.resize((max(1, int(sp.width * z)), max(1, int(sp.height * z))), Image.BILINEAR) if z > 1.001 else sp
        x, y = self.place(ov, scaled.width, scaled.height)
        canvas.alpha_composite(with_alpha(scaled, k), (x, y))

    # -- image card: cropped still with slow zoom, rounded corners, shadow and caption
    def image_parts(self, ov):
        key = ov["id"]
        if key in self.images:
            return self.images[key]
        im = Image.open(self.image_paths[ov["asset"]])
        im.draft("RGB", (self.W * 2, self.H * 2))
        im = im.convert("RGB")
        if ov.get("crop"):
            c = ov["crop"]
            x0 = min(max(0, c["x"]), im.width - 1)
            y0 = min(max(0, c["y"]), im.height - 1)
            box = (int(x0), int(y0), int(min(im.width, x0 + c["w"])), int(min(im.height, y0 + c["h"])))
            if box[2] - box[0] >= 10 and box[3] - box[1] >= 10:
                im = im.crop(box)
        w = int(min(ov["width"], self.W - 2 * self.margin))
        h = int(im.height * w / im.width)
        h = min(h, int(self.H * 0.62))
        radius = int(26 * self.s)
        mask = Image.new("L", (w, h), 0)
        ImageDraw.Draw(mask).rounded_rectangle([0, 0, w - 1, h - 1], radius, fill=255)
        pad = int(60 * self.s)
        shadow = Image.new("RGBA", (w + 2 * pad, h + 2 * pad), (0, 0, 0, 0))
        ImageDraw.Draw(shadow).rounded_rectangle([pad, pad + int(10 * self.s), pad + w, pad + h], radius, fill=(0, 0, 0, 170))
        shadow = shadow.filter(ImageFilter.GaussianBlur(int(28 * self.s)))
        caption = None
        if ov.get("citation"):
            f = self.fonts.get("", "sans", 26 * self.s, ov["citation"])
            probe = ImageDraw.Draw(Image.new("L", (1, 1)))
            label = visual(ov["citation"])
            caption = Image.new("RGBA", (min(w, text_w(probe, label, f) + int(24 * self.s)), int(f.size * 1.7)), (0, 0, 0, 0))
            d = ImageDraw.Draw(caption)
            d.rounded_rectangle([0, 0, caption.width - 1, caption.height - 1], int(8 * self.s), fill=(0, 0, 0, 160))
            d.text((int(12 * self.s), caption.height // 2), label, font=f, fill=(255, 255, 255, 230), anchor="lm")
        self.images[key] = (im, w, h, mask, shadow, pad, caption)
        return self.images[key]

    def image_card(self, canvas, ov, T):
        enter, leave, t = envelope(ov, T)
        k = enter * leave
        if k <= 0:
            return
        im, w, h, mask, shadow, pad, caption = self.image_parts(ov)
        span = ov["end"] - ov["start"]
        z = ov["zoom_start"] + (ov["zoom_end"] - ov["zoom_start"]) * ease_in_out(t / span)
        # Ken Burns inside the card frame: crop the still by z, keep the frame fixed.
        aspect = w / h
        cw = min(im.width, im.height * aspect) / max(z, 1e-3)
        ch = cw / aspect
        cw, ch = min(cw, im.width), min(ch, im.height)
        x0, y0 = (im.width - cw) / 2, (im.height - ch) / 2
        pic = im.resize((w, h), Image.BILINEAR, box=(x0, y0, x0 + cw, y0 + ch))
        card = Image.new("RGBA", (w, h), (0, 0, 0, 0))
        card.paste(pic, (0, 0), mask)
        grow = 0.93 + 0.07 * enter
        cw2, ch2 = max(1, int(w * grow)), max(1, int(h * grow))
        x, y = self.place(ov, cw2, ch2)
        sh = shadow.resize((max(1, int(shadow.width * grow)), max(1, int(shadow.height * grow))), Image.BILINEAR)
        canvas.alpha_composite(with_alpha(sh, k), (max(0, x - int(pad * grow)), max(0, y - int(pad * grow))))
        card = card.resize((cw2, ch2), Image.BILINEAR) if grow < 0.999 else card
        canvas.alpha_composite(with_alpha(card, k), (x, y))
        if caption is not None:
            cy = min(self.H - caption.height - self.margin // 2, y + ch2 + int(14 * self.s))
            canvas.alpha_composite(with_alpha(caption, k), (x, cy))


# ---------------------------------------------------------------- source video


class ClipReader:
    """Streams one clip's frames, already at output size, from its own FFmpeg process.
    Past the end of the source the last frame is held (never a black flash)."""

    def __init__(self, seg, plan):
        self.W, self.H, self.fps = plan["width"], plan["height"], plan["fps"]
        self.size = self.W * self.H * 3
        self.last = None
        play = (seg["end"] - seg["start"]) + seg.get("tail", 0)
        read = play * seg["speed"] + 2.0 / self.fps
        W, H = self.W, self.H
        if seg.get("fit") == "exact":
            fit = f"scale={W}:{H}:flags=bicubic,setsar=1"
        else:
            # Different aspect: the picture is kept whole over a blurred fill of itself.
            r = max(4, W // 40)
            fit = (f"split[a][b];[a]scale={W}:{H}:force_original_aspect_ratio=increase,crop={W}:{H},"
                   f"boxblur={r}:2[bg];[b]scale={W}:{H}:force_original_aspect_ratio=decrease[fg];"
                   f"[bg][fg]overlay=(W-w)/2:(H-h)/2,setsar=1")
        graph = f"[0:v]setpts=(PTS-STARTPTS)/{seg['speed']},fps={self.fps},{fit},format=rgb24[v]"
        args = [FFMPEG, "-v", "error", "-nostdin", "-threads", str(plan.get("threads", 2)),
                "-ss", f"{seg['sourceIn']:.3f}", "-t", f"{read:.3f}", "-i", seg["file"],
                "-filter_complex", graph, "-map", "[v]", "-an", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"]
        self.proc = subprocess.Popen(args, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, bufsize=self.size)

    def next(self):
        if self.proc is not None:
            raw = self.proc.stdout.read(self.size)
            if len(raw) == self.size:
                self.last = Image.frombytes("RGB", (self.W, self.H), raw)
            else:
                self.close()
        if self.last is None:
            self.last = Image.new("RGB", (self.W, self.H), (0, 0, 0))
        return self.last

    def close(self):
        if self.proc is not None:
            try:
                self.proc.stdout.close()
                self.proc.kill()
                self.proc.wait(timeout=5)
            except Exception:
                pass
            self.proc = None


def zoom_at(zooms, T):
    for z in zooms:
        if z["start"] <= T < z["end"]:
            u = (T - z["start"]) / max(1e-6, z["end"] - z["start"])
            return z, z["zoom_start"] + (z["zoom_end"] - z["zoom_start"]) * CURVES.get(z["curve"], ease_in_out)(u)
    return None, 1.0


def apply_zoom(frame, z, scale):
    """Punch-in on the program picture: crop a 1/scale window around the face anchor,
    with the face at 45 % of the window height (reference speaker())."""
    if scale <= 1.0005:
        return frame
    W, H = frame.size
    w, h = W / scale, H / scale
    x0 = min(max(z["face_x"] * W - w / 2, 0), W - w)
    y0 = min(max(z["face_y"] * H - h * 0.45, 0), H - h)
    return frame.resize((W, H), Image.BICUBIC, box=(x0, y0, x0 + w, y0 + h))


def blurred(frame, k):
    """Program picture blurred and dimmed behind an image card (downscaled blur: cheap)."""
    W, H = frame.size
    small = frame.resize((max(1, W // 8), max(1, H // 8)), Image.BILINEAR).filter(ImageFilter.GaussianBlur(3))
    soft = small.resize((W, H), Image.BILINEAR).point(lambda v: int(v * 0.55))
    return Image.blend(frame, soft, k) if k < 0.999 else soft


# ---------------------------------------------------------------- frame loop


def render(plan, emit, only=None):
    W, H, fps = plan["width"], plan["height"], plan["fps"]
    fonts = Fonts(plan.get("fonts"))
    ov = Overlays(plan, fonts)
    black = Image.new("RGB", (W, H), (0, 0, 0))
    segments = plan["segments"]
    overlays = sorted(plan["overlays"], key=lambda o: (o["type"] not in ("image_card",), o["type"] == "credit", o["start"]))
    readers = {}
    draw = {
        "lower_third": ov.lower_third, "pill": ov.pill, "credit": ov.credit, "headline": ov.headline,
        "quote": ov.quote, "stamp": ov.stamp, "image_card": ov.image_card,
    }
    want = sorted(only) if only else None
    total = plan["frames"]
    for n in range(total):
        T = n / fps
        if want is not None and T > want[-1] + 1.0 / fps:
            break
        # --- 1. program picture
        cur_i = next((i for i, s in enumerate(segments) if s["start"] <= T < s["end"]), len(segments) - 1)
        frames = {}
        for i, seg in enumerate(segments):
            if seg["type"] != "clip":
                continue
            live_until = seg["end"] + seg.get("tail", 0)
            if seg["start"] <= T < live_until or (i == cur_i):
                if i not in readers:
                    readers[i] = ClipReader(seg, plan)
                frames[i] = readers[i].next()
            elif i in readers and T >= live_until:
                readers.pop(i).close()
        seg = segments[cur_i]
        pic = frames.get(cur_i, black) if seg["type"] == "clip" else black
        if seg["type"] == "clip" and seg["transition"] != "cut" and T < seg["start"] + seg["transitionSeconds"]:
            p = ease_in_out((T - seg["start"]) / max(1e-6, seg["transitionSeconds"]))
            prev = frames.get(cur_i - 1) if cur_i > 0 and segments[cur_i - 1]["type"] == "clip" else None
            if seg["transition"] == "fade" or prev is None:
                pic = Image.blend(black, pic, p)
            elif seg["transition"] == "dissolve":
                pic = Image.blend(prev, pic, p)
            else:  # slide: the new clip slides in from the right over the outgoing one
                comp = prev.copy()
                comp.paste(pic, (int(W * (1 - p)), 0))
                pic = comp
        # --- 2. speaker zoom on the footage itself
        z, scale = zoom_at(plan["zooms"], T)
        if z is not None:
            pic = apply_zoom(pic, z, scale)
        # --- 3. image cards dim and blur the program behind them
        active = [o for o in overlays if o["start"] <= T < o["end"]]
        cards = [o for o in active if o["type"] == "image_card"]
        if cards:
            k = max(envelope(o, T)[0] * envelope(o, T)[1] for o in cards)
            if k > 0:
                pic = blurred(pic, k)
        # --- 4. overlays
        if want is not None and not any(abs(T - w) < 0.5 / fps for w in want):
            continue
        if active:
            canvas = pic.convert("RGBA")
            for o in active:
                draw[o["type"]](canvas, o, T)
            pic = canvas.convert("RGB")
        emit(n, T, pic)
    for r in readers.values():
        r.close()
    return {"fonts": fonts.used, "raqm": RAQM, "frames": total}


def main():
    if len(sys.argv) > 1 and sys.argv[1] == "--self-check":
        import PIL
        print(json.dumps({"pillow": PIL.__version__, "raqm": RAQM, "python": sys.version.split()[0]}))
        return
    with open(sys.argv[1], "r", encoding="utf-8") as fh:
        plan = json.load(fh)
    report_path = plan.get("report")
    if len(sys.argv) >= 4 and sys.argv[2] == "--preview":
        times = [float(x) for x in sys.argv[3].split(",") if x.strip()]
        out_dir = sys.argv[4] if len(sys.argv) > 4 else "."

        def save(n, T, pic):
            pic.save(os.path.join(out_dir, f"frame_{int(round(T * 1000)):07d}.jpg"), quality=88)

        info = render(plan, save, only=times)
    else:
        out = sys.stdout.buffer

        def write(n, T, pic):
            out.write(pic.tobytes())

        try:
            info = render(plan, write)
            out.flush()
        except BrokenPipeError:
            sys.exit(3)  # the encoder went away (cancel or failure): nothing more to do
    if report_path:
        with open(report_path, "w", encoding="utf-8") as fh:
            json.dump(info, fh)


if __name__ == "__main__":
    main()
