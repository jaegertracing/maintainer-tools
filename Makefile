.PHONY: install build fmt lint test triage

build:
	pnpm run build

install:
	pnpm install --frozen-lockfile

fmt:
	pnpm run fmt

lint:
	pnpm run lint

test:
	pnpm run test

triage:
	pnpm run triage $(ARGS)
