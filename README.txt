Optional custom art and sounds (the site draws its own pixel art and synthesizes its own sounds if you add nothing).

ART:   put PNG files in assets/items/ named after the thing they replace (any size; square, pixel art looks best):
         items:       w1.png ... t3.png          (the ids in lib/content.js)
         materials:   shard.png  essence.png  relic.png
         consumables: shield.png tonic.png draught.png brew.png catalyst.png
SOUNDS: put MP3 files in assets/sfx/ named: click equip buy craft discover levelup error ach
THEN list what you added in assets/manifest.json, for example:
  { "items": ["w2", "shard"], "sfx": ["craft"] }
Only use art and sound you have the right to use (for example CC0 packs). Do not use Minecraft's or Chess.com's assets.
