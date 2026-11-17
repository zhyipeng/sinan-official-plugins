"""Compare synthetic output against source text as well as an imperfect baseline."""
from collections import Counter


def normalize(text):
    return "".join(text.split())


def distance(left, right):
    previous = list(range(len(right) + 1))
    for i, a in enumerate(left, 1):
        row = [i]
        for j, b in enumerate(right, 1):
            row.append(min(row[-1] + 1, previous[j] + 1, previous[j - 1] + (a != b)))
        previous = row
    return previous[-1]


def evaluate(source, baseline, actual):
    source, baseline, actual = map(normalize, (source, baseline, actual))
    reference_edits, actual_edits = distance(source, baseline), distance(source, actual)
    def character_delta(value):
        source_chars, actual_chars = Counter(source), Counter(value)
        return sum((source_chars - actual_chars).values()) + sum((actual_chars - source_chars).values())
    reference_delta, actual_delta = character_delta(baseline), character_delta(actual)
    return {"source_characters": len(source), "baseline_edits": reference_edits,
            "actual_edits": actual_edits, "baseline_character_delta": reference_delta,
            "actual_character_delta": actual_delta,
            "not_worse_than_baseline": actual_edits <= reference_edits and actual_delta <= reference_delta,
            "matches_native_baseline": actual == baseline}
