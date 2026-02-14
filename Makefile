.PHONY: doctor build test typecheck contracts-deps contracts-test circuit-check circuit-verifier circuit-fixture deploy-sepolia deploy-anvil-dummy deploy-sepolia-dummy-service sepolia-live anvil-live e2e-anvil

doctor:
	pnpm doctor

build:
	pnpm build

test:
	pnpm test

typecheck:
	pnpm typecheck

contracts-deps:
	pnpm contracts:deps

contracts-test:
	pnpm contracts:test

circuit-check:
	pnpm circuit:check

circuit-verifier:
	pnpm circuit:verifier

circuit-fixture:
	pnpm circuit:fixture

deploy-sepolia:
	pnpm deploy:sepolia

deploy-anvil-dummy:
	pnpm deploy:anvil:dummy

deploy-sepolia-dummy-service:
	pnpm deploy:sepolia:dummy-service

sepolia-live:
	pnpm test:sepolia-live

anvil-live:
	pnpm test:anvil-live

e2e-anvil:
	pnpm e2e:anvil
