{{#if stopped}}Supervised process {{name}} was stopped.{{else}}Supervised process {{name}} {{state}} {{#if hasExitCode}}with exit code {{exitCode}}{{else}}without an exit code{{/if}}.{{/if}}
