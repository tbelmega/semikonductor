# Smithy reference

Templates, patterns and file layouts for a Smithy API model. `guide.md` next to this file says
when to use each; `review.md` uses the example review at the end as the model for its output.

## Model skeleton

```smithy
$version: "2"

namespace [appropriate.namespace]

/// [Detailed service description]
@title("[Service Title]")
service [ServiceName] {
    version: "[YYYY-MM-DD]"
    operations: [
        [Operation1]
        [Operation2]
    ]
}

/// Operation documentation
@http(method: "[METHOD]", uri: "[/path/{param}]")
@readonly  // if applicable
operation [OperationName] {
    input: [OperationInput]
    output: [OperationOutput]
    errors: [
        [Error1]
        [Error2]
    ]
}

/// Input structure documentation
structure [OperationInput] {
    /// Field documentation
    @required
    [fieldName]: [Type]
}

/// Output structure documentation
structure [OperationOutput] {
    /// Field documentation
    [fieldName]: [Type]
}

/// Error documentation
@error("client")
@httpError(404)
structure [ErrorName] {
    @required
    message: String
}
```

## Create, read, update and delete operations

```smithy
@http(method: "POST", uri: "/users")
operation CreateUser {
    input: CreateUserInput
    output: CreateUserOutput
    errors: [ValidationError, ConflictError]
}

@http(method: "GET", uri: "/users/{userId}")
@readonly
operation GetUser {
    input: GetUserInput
    output: GetUserOutput
    errors: [UserNotFound, UnauthorizedAccess]
}

@http(method: "PUT", uri: "/users/{userId}")
@idempotent
operation UpdateUser {
    input: UpdateUserInput
    output: UpdateUserOutput
    errors: [UserNotFound, ValidationError]
}

@http(method: "DELETE", uri: "/users/{userId}")
@idempotent
operation DeleteUser {
    input: DeleteUserInput
    output: DeleteUserOutput
    errors: [UserNotFound]
}
```

## Paginated list

```smithy
@http(method: "GET", uri: "/users")
@readonly
@paginated(
    inputToken: "nextToken"
    outputToken: "nextToken"
    pageSize: "maxResults"
)
operation ListUsers {
    input: ListUsersInput
    output: ListUsersOutput
}

structure ListUsersInput {
    @httpQuery("maxResults")
    @range(min: 1, max: 100)
    maxResults: Integer = 20

    @httpQuery("nextToken")
    nextToken: String
}

structure ListUsersOutput {
    @required
    users: UserList

    nextToken: String
}
```

## Validation patterns

```smithy
@pattern("^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\\.[a-zA-Z]{2,}$")
string Email

@range(min: 0, max: 150)
integer Age

@length(min: 8, max: 128)
string Password

@length(min: 1, max: 100)
list UserList {
    member: User
}
```

## File layouts

By component:

```text
model/
├── service.smithy           # Service definition and metadata
├── operations.smithy        # Operation definitions
├── inputs.smithy            # Input structures
├── outputs.smithy           # Output structures
├── errors.smithy            # Error definitions
├── types.smithy             # Common types (enums, custom types)
└── validators.smithy        # Validation metadata
```

By domain:

```text
model/
├── service.smithy           # Service definition
├── user/
│   ├── operations.smithy    # User-related operations
│   ├── types.smithy         # User data structures
│   └── errors.smithy        # User-specific errors
├── todo/
│   ├── operations.smithy    # Todo-related operations
│   ├── types.smithy         # Todo data structures
│   └── errors.smithy        # Todo-specific errors
└── common/
    ├── types.smithy         # Shared types
    └── errors.smithy        # Common errors
```

## Example files of a split model

### service.smithy

Only the service shape and its metadata:

```smithy
$version: "2"

namespace com.example.todo

/// RESTful service for managing todo items
@title("Todo Service")
service TodoService {
    version: "2024-11-14"
    operations: [
        CreateTodo
        GetTodo
        UpdateTodo
        DeleteTodo
        ListTodos
    ]
}
```

### operations.smithy

Operation definitions with their HTTP traits:

```smithy
$version: "2"

namespace com.example.todo

/// Creates a new todo item
@http(method: "POST", uri: "/todos")
operation CreateTodo {
    input: CreateTodoInput
    output: CreateTodoOutput
    errors: [ValidationError, ServiceUnavailable]
}

/// Retrieves a specific todo item
@http(method: "GET", uri: "/todos/{todoId}")
@readonly
operation GetTodo {
    input: GetTodoInput
    output: GetTodoOutput
    errors: [TodoNotFound, UnauthorizedAccess]
}
```

### types.smithy

Data structures and custom types:

```smithy
$version: "2"

namespace com.example.todo

/// Represents a todo item
structure Todo {
    @required
    todoId: String

    @required
    title: String

    @required
    completed: Boolean
}

/// Priority levels for todos
enum Priority {
    LOW = "low"
    MEDIUM = "medium"
    HIGH = "high"
}
```

### errors.smithy

Every error definition:

```smithy
$version: "2"

namespace com.example.todo

/// Todo item was not found
@error("client")
@httpError(404)
structure TodoNotFound {
    @required
    message: String
    todoId: String
}

/// Request validation failed
@error("client")
@httpError(400)
structure ValidationError {
    @required
    message: String
    fieldErrors: FieldErrorList
}
```

### validators.smithy

Validation metadata and custom validators:

```smithy
$version: "2"

metadata validators = [
    {
        name: "EmitEachSelector"
        id: "MissingDocumentation"
        message: "All public shapes must have documentation"
        severity: "WARNING"
        selector: """
            :not([trait|documentation])
            :not([trait|internal])
        """
    }
]
```

## Build configuration

`smithy-build.json` for a model in several files:

```json
{
  "version": "1.0",
  "sources": ["model"],
  "maven": {
    "dependencies": ["software.amazon.smithy:smithy-model:1.51.0"]
  }
}
```

## Example review

An example of the review output that `review.md` describes, for a weather service.

````markdown
## Smithy Model Review: WeatherService

### Critical Issues

**Type Safety**: WeatherData.temperature
Issue: Temperature field is untyped String without constraints
Impact: Allows invalid values, breaks type safety in generated code
Fix: Define specific type with validation
Example:

```smithy
/// Temperature in Celsius. Range: -273.15 to 1000
@range(min: -273.15, max: 1000)
double TemperatureCelsius
```

**Error Handling**: GetForecast operation
Issue: Only defines GenericError, missing specific error types
Impact: Clients can't handle different failure scenarios appropriately
Fix: Define specific error types for each failure case
Example:

```smithy
operation GetForecast {
    input: GetForecastInput
    output: GetForecastOutput
    errors: [
        LocationNotFound
        ServiceUnavailable
        InvalidDateRange
    ]
}
```

**Security**: User.email field
Issue: Email field not marked as sensitive
Impact: Personal data can appear in logs and traces of generated code
Fix: Mark personal data with the @sensitive trait
Example:

```smithy
structure User {
    @sensitive
    email: String
}
```

### Warnings

**Documentation**: ListLocations operation
Issue: Missing documentation on pagination behavior
Recommendation: Document pagination limits and token usage
Example:

```smithy
@documentation("""
Lists available weather locations with pagination support.
Returns up to 100 locations per request. Use nextToken for additional pages.
""")
@paginated(inputToken: "nextToken", outputToken: "nextToken", pageSize: "maxResults")
operation ListLocations { ... }
```

### Suggestions

**Performance**: ListLocations operation
Observation: No default page size specified
Benefit: Prevents accidentally large responses
Alternative: Add default value to maxResults
Example:

```smithy
structure ListLocationsInput {
    @range(min: 1, max: 100)
    maxResults: Integer = 20
}
```

**File Organization**: Single file model
Observation: Model contains 15 operations and 600+ lines in single file
Benefit: Splitting improves maintainability and enables parallel development
Alternative: Organize into logical component files

### Positive Findings

**Naming Conventions**
All shapes follow PascalCase/camelCase conventions consistently

**HTTP Traits**
Operations properly use @readonly and @idempotent where appropriate

**Validation**
Good use of @pattern for email validation
````
