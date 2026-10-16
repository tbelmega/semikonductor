# Designing an API model in Smithy

How to design a service's API as a Smithy model: the service definition, its operations, the input
and output shapes, validation rules, errors and pagination. The model is the API contract that
client and server code, OpenAPI specifications and AWS SDK code are generated from, so it is
designed before the implementation. `review.md` next to this file says how the model is reviewed;
run it as the checker after writing the model, preferably in a separate pass that did not write
it. `smithy-reference.md` next to this file holds the templates, patterns and file layouts this
guide refers to.

## Inputs

Use the paths the step or its consumed artifacts give you, typically the system design, the
requirements or user stories, and any existing API specification. Where the requirements leave an
API decision open, such as a resource boundary, an error case or a limit, ask the owner, unless
the step or its inputs already say. The step's artifact path decides where the model is written;
for standalone use, the default is a `model/` directory.

## 1. Read the requirements into a model outline

1. **Service boundaries.** Settle the service name, its version and its scope.
2. **Operations.** List every operation the API needs.
3. **Data structures.** Find the input and output shapes and how they relate.
4. **Validation rules.** Extract the constraints the requirements state.
5. **Error scenarios.** List the failure cases and the error type each one needs.
6. **Code generation targets.** Note which targets the model must support, such as TypeScript,
   OpenAPI or AWS SDK code.

## 2. Define the service

Write the service shape with its title, its documentation and a version, and list every
operation it provides. Use a valid reverse domain name namespace. Start from the model skeleton in
`smithy-reference.md`.

## 3. Model the operations

- Keep each operation focused on one purpose, with its own input and output structure.
- Apply the HTTP traits: `@http` on every operation, `@readonly` on reads and `@idempotent` where
  the operation is idempotent. Use the HTTP method that matches the effect: never GET for a
  mutation. Keep URI patterns consistent with REST conventions.
- List every error the operation can return.

The create, read, update and delete pattern in `smithy-reference.md` shows a typical set.

## 4. Design the shapes

- Use the shape type that fits: structure, string, integer, list, map and so on. Avoid overly
  generic shapes, such as a `Document` field or `String` for everything, and create specific
  types for domain concepts. Use enums for fixed sets of values.
- Define reusable shapes for common patterns, such as identifiers and timestamps.
- Avoid deeply nested structures, and do not expose internal implementation details.

Naming conventions:

- Services: PascalCase, such as `WeatherService`.
- Operations: PascalCase verbs, such as `GetForecast` or `CreateUser`.
- Shapes: PascalCase nouns, such as `UserProfile` or `WeatherData`.
- Members: camelCase, such as `userId` or `temperatureCelsius`; never snake_case.
- Names are descriptive and specific to the domain, without unclear abbreviations.

Documentation: document every public shape, with a `///` doc comment or the `@documentation`
trait, not both on the same shape. Explain the purpose, the constraints and validation rules, the
business logic and edge cases, and the units of numeric values. Add examples where they help.

## 5. Apply validation and security traits

- `@required` on every mandatory member.
- `@range` for numeric bounds.
- `@length` for the size limits of strings and collections.
- `@pattern` for formats such as email addresses and URLs.
- `@sensitive` on passwords, tokens and personal data.
- Authentication traits on every operation that requires authentication.

Every string and number gets a constraint. The validation patterns in `smithy-reference.md` show
the common cases.

## 6. Design the errors

- Define a specific error type for each failure scenario, not a generic one.
- Use `@error("client")` for 4xx errors and `@error("server")` for 5xx errors, with `@httpError`
  and the matching status code.
- Include a helpful message and context fields in each error structure.
- Handle errors the same way across operations.

## 7. Paginate list operations

Every list operation gets the `@paginated` trait with `inputToken`, `outputToken` and `pageSize`,
and a page size with a sensible default and maximum. `smithy-reference.md` has the pattern.

## 8. Organize the files

Use a single file when the service has fewer than 10 operations, the operations and data
structures are tightly related, or the model is a prototype for a team of one or two. Split the
model into several files when it has 10 or more operations, spans several domains or resource
types, shares types across services, or several people edit it at once. Start with one file and
split it when it exceeds 500 lines, when several developers edit it at the same time, when clear
domain boundaries emerge, or when shared types need reuse across services.

`smithy-reference.md` shows a layout by component and a layout by domain, with an example of each
file. When splitting:

- Use the same namespace in every file of the model.
- Group related shapes in one file and keep each file to one concern, but do not create files with
  only one or two shapes.
- Do not duplicate a shape definition across files, and do not create circular dependencies
  between files.
- Name files consistently, in lowercase with hyphens, say what each file is for at its top, and
  order the shapes logically.

Point `sources` in `smithy-build.json` at the model directory; Smithy loads every `.smithy` file
in it.

## 9. Plan for evolution

Consider how the API will evolve and state the versioning strategy. A breaking change needs a new
version. Where there are several valid designs, describe the alternatives and explain the choice
in the documentation or in comments.

## Deliverables

1. The complete Smithy model, with every shape defined.
2. `smithy-build.json`, if code is generated.
3. Validation metadata for linting and quality checks.
4. Documentation that explains the design decisions.
5. Example usage of the generated code.

## Check before handing over

The model validates without errors with `smithy validate`, and the generated code compiles for
every target, with serialization and deserialization working. Then check it against this list.

Must fix:

- The service namespace is missing or is not a valid reverse domain name.
- An operation lacks its `@http` trait.
- A failure case has no error shape.
- An input or output shape lacks a member it requires.

Should fix:

- An operation or shape has no documentation.
- A list operation has no pagination.
- A string or numeric input has no `@length`, `@range` or `@pattern` constraint.

Worth considering:

- `@examples` traits for the documentation.
- Reusable common shapes, such as timestamps and identifiers.
