.PHONY: setup build test package package-all

setup:
	npm ci --ignore-scripts

build:
	npm run build

test:
	npm test

package: build
	node scripts/package.mjs

package-all:
	npm run package:all
