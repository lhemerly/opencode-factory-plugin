# Validation scope

The consumer test suite uses protocol fixtures and real loopback HTTP for transport failures. It exercises the four tool contracts, runtime argument/response validation, binding checks, idempotency reconciliation, cancellation and cleanup. A separate smoke script launches the pinned OpenCode 1.19.0 server with a temporary isolated configuration, checks registration of all four tool IDs and disposes its instance. It does not call a model provider.

These checks demonstrate plugin behavior. They do not demonstrate a production verifier, queue durability, OS isolation, controller authorization, real integration, delivery or controller operation without the plugin. The fixture controller is test-only and is not shipped as a production controller.

Before production acceptance, connect an independently deployed protocol 0.1 controller, inspect an approved task inside OpenCode, request real verification for an exact commit, submit the matching candidate and inspect the controller's integrated-commit delivery record. Repeat with the plugin disabled and the controller's worker adapter active. Include disconnection during verification and controller restart between integration and delivery acknowledgment. The plugin cannot certify those controller properties.

Upgrade OpenCode, SDK or protocol only after rerunning consumer and runtime checks against the exact replacement versions. Dependency versions and the lockfile are committed for reproducible installation.
