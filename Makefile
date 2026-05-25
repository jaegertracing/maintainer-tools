.PHONY: build fmt lint test triage

build:
	npm run build

fmt:
	npm run fmt

lint:
	npm run lint

test:
	npm run test

triage:
	npm run triage -- $(ARGS)
