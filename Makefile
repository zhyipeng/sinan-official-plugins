.PHONY: build test package

build:
	mkdir -p bin/plugins/json-tool/backend bin/plugins/json-tool/ui
	cp plugins/json-tool/manifest.json bin/plugins/json-tool/manifest.json
	cp plugins/json-tool/ui/* bin/plugins/json-tool/ui/
	cp third_party/sinan/packages/plugin-sdk/ui/index.js bin/plugins/json-tool/ui/bridge.js
	go build -o bin/plugins/json-tool/backend/plugin ./plugins/json-tool/cmd

test:
	go test -race ./...
	go vet ./...

package: build
	python3 scripts/package.py
