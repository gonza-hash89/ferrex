#!/usr/bin/env python3
"""
Generador de iconos FERREX PNG a partir del SVG original.
Crea icon-192.png, icon-512.png, icon-192-maskable.png, icon-512-maskable.png
en la carpeta icons/ del proyecto Ferrex-web.
"""
import math
import struct
import zlib
from pathlib import Path

# Ruta al proyecto
PROJECT = Path("/c/Users/GONZALO FABIO/OneDrive/Programas/Trabajos de programacion/Ferrex-web")
ICONS_DIR = PROJECT / "icons"

# Asegurar que el directorio icons existe
ICONS_DIR.mkdir(parents=True, exist_ok=True)

# Dimensiones de los iconos
SIZES = {
    "icon-192.png": 192,
    "icon-512.png": 512,
    "icon-192-maskable.png": 192,
    "icon-512-maskable.png": 512,
}

# Colores del icono FERREX (recortados de la paleta original)
COLORS = {
    "bg": (44, 62, 80),        # #2C3E50
    "accent_primary": (243, 156, 18),  # #F39C12
    "accent_neon": (23, 255, 0),       # #17FF00
    "text": (255, 255, 255),           # #FFFFFF
    "text_dim": (241, 196, 15),        # #F1C40F
    "bg_card": (22, 27, 34),           # #161B22
}


def create_simple_icon(size: int, mode: str = "standard") -> bytes:
    """Crea un icono PNG simple sin librerías externas."""
    pixels = bytearray(size * size * 4)

    # Dibujar fondo base
    for i in range(size * size):
        idx = i * 4
        pixels[idx] = COLORS["bg"][0]
        pixels[idx + 1] = COLORS["bg"][1]
        pixels[idx + 2] = COLORS["bg"][2]
        pixels[idx + 3] = 255

    # Dibujar formas básicas
    for y in range(size):
        for x in range(size):
            cx = x + 0.5
            cy = y + 0.5
            dist = math.sqrt((cx - size / 2) ** 2 + (cy - size / 2) ** 2)
            idx = (y * size + x) * 4

            if mode == "maskable":
                if dist > size * 0.4:
                    pixels[idx] = COLORS["bg"][0]
                    pixels[idx + 1] = COLORS["bg"][1]
                    pixels[idx + 2] = COLORS["bg"][2]
                    continue
            else:
                pass

            # Anillo principal (color neón)
            r_ring = size * 0.42
            dr = 2.5
            if abs(dist - r_ring) < dr:
                pixels[idx] = COLORS["accent_neon"][0]
                pixels[idx + 1] = COLORS["accent_neon"][1]
                pixels[idx + 2] = COLORS["accent_neon"][2]
                pixels[idx + 3] = 255

            # Círculo interno (color blanco)
            r_inner = size * 0.22
            if abs(dist - r_inner) < dr:
                pixels[idx] = COLORS["text"][0]
                pixels[idx + 1] = COLORS["text"][1]
                pixels[idx + 2] = COLORS["text"][2]
                pixels[idx + 3] = 255

            # Punto central (para maskable)
            if mode == "maskable" and dist < size * 0.05:
                pixels[idx] = COLORS["text"][0]
                pixels[idx + 1] = COLORS["text"][1]
                pixels[idx + 2] = COLORS["text"][2]
                pixels[idx + 3] = 255

    return bytes(pixels)


def write_png(filename: str, width: int, height: int, pixels: bytes) -> None:
    """Escribir un archivo PNG desde píxeles RGBA."""
    stride = width * 4
    padding = (4 - (stride % 4)) % 4

    # Preparar filas para compresión (filter type 0 = None)
    raw_rows = b""
    for y in range(height):
        row = pixels[y * stride:(y + 1) * stride]
        raw_rows += bytes([0]) + row

    raw_compressed = zlib.compress(raw_rows, 9)

    def chunk(type_: bytes, data: bytes) -> bytes:
        return (
            struct.pack(">I", len(data))
            + type_
            + data
            + struct.pack(">I", zlib.crc32(type_ + data) & 0xFFFFFFFF)
        )

    # Firma PNG
    png = b"\x89PNG\r\n\x1a\n"
    ihdr_data = struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0)
    png += chunk(b"IHDR", ihdr_data)
    png += chunk(b"IDAT", raw_compressed)
    png += chunk(b"IEND", b"")

    path = Path(filename)
    path.write_bytes(png)

    # Verificar escritura
    assert path.exists(), f"ERROR: no se pudo escribir {path}"
    assert path.stat().st_size > 0, f"ERROR: archivo vacío {path}"

    print(f"  OK: {path.name} ({width}x{height}), {path.stat().st_size} bytes")


def generate_icons():
    """Generar todos los iconos."""
    print("Generando iconos FERREX...")
    for name, size in SIZES.items():
        maskable = "maskable" in name
        pixels = create_simple_icon(size, mode="maskable" if maskable else "standard")
        write_png(str(ICONS_DIR / name), size, size, pixels)
    print("Iconos generados correctamente.")


if __name__ == "__main__":
    generate_icons()
