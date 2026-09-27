.PHONY: install build fmt lint tsc-lint test triage

build:
	pnpm run build

install:
	pnpm install --frozen-lockfile

fmt:
	pnpm run fmt

lint:
	pnpm run lint

tsc-lint:
	pnpm run tsc-lint

test:
	pnpm run test

triage:
	pnpm run triage $(ARGS)
