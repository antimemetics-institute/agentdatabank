#!/usr/bin/env python3
"""Draw the GovSim overview using only Python's standard library.

Run from any directory: python3 /path/to/experiments/govsim/scripts/figures.py
The SVG is written beside the experiment README. Seeded, lightly doubled
strokes echo the hand-drawn style of the data-bank grant figure.
"""
from html import escape
from math import atan2, cos, pi, sin
from pathlib import Path
import random


INK = "#263741"
BLUE = "#e5f3fa"
GREEN = "#27644f"
RUST = "#924535"


def draw() -> str:
    rng = random.Random(17)
    parts = []

    def path(d, fill="none", stroke=INK, width=1.8):
        parts.append(f'<path d="{d}" fill="{fill}" stroke="{stroke}" '
                     f'stroke-width="{width}" stroke-linecap="round" '
                     'stroke-linejoin="round"/>')

    def line(x1, y1, x2, y2, stroke=INK, width=1.8):
        for _ in range(2):
            j = lambda: rng.uniform(-0.65, 0.65)
            path(f'M {x1+j():.1f} {y1+j():.1f} '
                 f'Q {(x1+x2)/2+j():.1f} {(y1+y2)/2+j():.1f} '
                 f'{x2+j():.1f} {y2+j():.1f}', stroke=stroke, width=width)

    def ellipse(cx, cy, rx, ry, fill="white", stroke=INK):
        parts.append(f'<ellipse cx="{cx}" cy="{cy}" rx="{rx}" ry="{ry}" fill="{fill}"/>')
        for _ in range(2):
            points = [(cx + rx*cos(i*pi/24) + rng.uniform(-0.5, 0.5),
                       cy + ry*sin(i*pi/24) + rng.uniform(-0.5, 0.5))
                      for i in range(48)]
            path('M ' + ' L '.join(f'{x:.1f} {y:.1f}' for x, y in points) + ' Z', stroke=stroke)

    def text(x, y, value, size=20, bold=False, fill=INK):
        parts.append(f'<text x="{x}" y="{y}" text-anchor="middle" '
                     f'font-family="sans-serif" font-size="{size}" '
                     f'font-weight="{600 if bold else 400}" fill="{fill}">{escape(value)}</text>')

    def person(x, y):
        ellipse(x, y, 10, 10)
        line(x, y+11, x, y+36)
        line(x-17, y+23, x+17, y+23)
        line(x, y+36, x-13, y+56)
        line(x, y+36, x+13, y+56)

    def fish(x, y, scale=1, stroke=INK):
        parts.append(f'<g transform="translate({x} {y}) scale({scale})">')
        path('M -13 0 Q -2 -12 13 0 Q -2 12 -13 0 L -22 -8 L -22 8 Z',
             fill="white", stroke=stroke)
        parts.append(f'<circle cx="6" cy="-1" r="1.5" fill="{stroke}"/>')
        parts.append('</g>')

    def lake(cx, cy, rx, ry, fish_positions, fill=BLUE, stroke=INK):
        ellipse(cx, cy, rx, ry, fill=fill, stroke=stroke)
        for dx, dy in fish_positions:
            fish(cx+dx, cy+dy, 0.85, stroke)

    def arrow(x1, y1, x2, y2, stroke):
        line(x1, y1, x2, y2, stroke)
        angle = atan2(y2-y1, x2-x1)
        for sign in [-1, 1]:
            line(x2, y2, x2-12*cos(angle+sign*0.5), y2-12*sin(angle+sign*0.5), stroke)

    text(250, 38, 'Five agents, one shared lake', 24, True)
    # An illustrative question, not a transcript or a prescribed agreement.
    path('M 150 72 Q 150 60 162 60 L 338 60 Q 350 60 350 72 '
         'L 350 111 Q 350 123 338 123 L 266 123 L 246 147 '
         'L 247 123 L 162 123 Q 150 123 150 111 Z', fill='#fff5d9')
    text(250, 87, 'Can we agree', 19)
    text(250, 110, 'on catch limits?', 19)

    lake(250, 300, 176, 66, [(-95,-17), (-20,-29), (59,-13), (113,13),
                           (-56,12), (20,22), (-106,30)])
    for x, y in [(76,194), (246,169), (418,194), (145,382), (353,382)]:
        person(x, y)
    # A straight raised rod and a vertical hanging line read as distinct parts.
    for hand, tip, water_y in [((93,217),(145,195),274),
                               ((263,192),(300,170),266),
                               ((401,217),(349,195),274),
                               ((162,405),(200,300),336),
                               ((336,405),(298,300),336)]:
        path(f'M {hand[0]} {hand[1]} L {tip[0]} {tip[1]}', width=2.4)
        path(f'M {tip[0]} {tip[1]} L {tip[0]} {water_y}', width=1)
        parts.append(f'<circle cx="{tip[0]}" cy="{water_y}" r="2.5" fill="{INK}"/>')
    text(250, 480, 'Each agent chooses its own catch.', 19)

    arrow(451, 275, 590, 183, GREEN)
    arrow(451, 325, 590, 417, RUST)

    text(766, 72, 'Leave enough fish', 24, True, GREEN)
    text(766, 101, 'The population can recover.', 19)
    lake(766, 183, 158, 61, [(-89,-17), (-25,-28), (42,-16), (98,8),
                            (-54,10), (11,9), (54,32)], fill='#e8f4eb', stroke=GREEN)

    text(766, 295, 'Take too many', 24, True, RUST)
    text(766, 324, 'The shared stock is depleted.', 19)
    lake(766, 417, 158, 61, [(0,5)], fill='#fbefe8', stroke=RUST)

    return ('<svg xmlns="http://www.w3.org/2000/svg" width="1020" height="510" '
            'viewBox="0 0 1020 510" role="img" aria-labelledby="title desc">\n'
            '<title id="title">GovSim: sharing a fishery</title>\n'
            '<desc id="desc">Five agents share a lake and discuss catch limits. '
            'Each chooses its own catch. Leaving enough fish allows recovery; '
            'taking too many depletes the shared stock. This is a conceptual '
            'illustration, not a simulation result.</desc>\n'
            '<rect width="1020" height="510" fill="#ffffff"/>\n'
            + '\n'.join(parts) + '\n</svg>\n')


def main() -> None:
    target = Path(__file__).resolve().parent.parent / 'overview.svg'
    target.write_text(draw(), encoding='utf-8')
    print(target)


if __name__ == '__main__':
    main()
