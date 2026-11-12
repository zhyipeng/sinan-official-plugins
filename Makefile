.PHONY: setup build test package

setup:
	npm ci --ignore-scripts

build:
	npm run build

test:
	npm test

package: build
	python3 scripts/package.py
