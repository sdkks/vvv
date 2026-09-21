.PHONY: all install hooks typecheck lint lint-fix format format-check test test-watch build secrets ci release release-dry clean image

all: typecheck lint build test

# Install dependencies (also installs git hooks via the prepare script)
install:
	pnpm install

# Install git hooks explicitly (use after clone, or if core.hooksPath got clobbered)
hooks:
	pnpm exec husky

typecheck:
	pnpm run typecheck

lint:
	pnpm run lint

lint-fix:
	pnpm run lint:fix

format:
	pnpm run format

format-check:
	pnpm run format:check

test:
	pnpm run test

test-watch:
	pnpm run test:watch

build:
	pnpm run build

image:
	podman build --format docker -t localhost/vvv:latest .

# Scan the full git history for leaked secrets
secrets:
	gitleaks detect --verbose

ci: typecheck lint build test secrets

# Preview the next release (version bump + notes) without publishing
release-dry:
	pnpm run release:dry

release:
	pnpm run release

clean:
	rm -rf dist coverage
