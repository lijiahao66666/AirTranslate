"""Test machine translation engines."""
import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'worker'))

from translators import translate_machine

texts = [
    "Once upon a time, there was a small village at the foot of a great mountain.",
    "The villagers lived peaceful lives, farming the fertile land.",
    "One day, a mysterious stranger arrived at the village gate.",
]

print("=== Testing Machine Translation (EN -> ZH) ===")
print(f"Input ({len(texts)} texts):")
for i, t in enumerate(texts):
    print(f"  [{i}] {t}")

print("\nTranslating...")
try:
    results = translate_machine(texts, "en", "zh")
    print(f"\nOutput ({len(results)} texts):")
    for i, t in enumerate(results):
        print(f"  [{i}] {t}")
    print("\n✅ Machine translation works!")
except Exception as e:
    print(f"\n❌ Machine translation failed: {e}")
    import traceback
    traceback.print_exc()
