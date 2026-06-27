export type SchemaValidationResult =
  | { ok: true }
  | { ok: false; errors: string[] };

export function validateSchema(
  schema: Record<string, unknown>,
  value: unknown,
  valuePath = "args",
): SchemaValidationResult {
  const errors: string[] = [];
  validateValue(schema, value, valuePath, errors);
  return errors.length > 0 ? { ok: false, errors } : { ok: true };
}

function validateValue(
  schema: Record<string, unknown>,
  value: unknown,
  valuePath: string,
  errors: string[],
): void {
  const enumValues = Array.isArray(schema.enum) ? schema.enum : undefined;

  if (enumValues && !enumValues.includes(value)) {
    errors.push(`${valuePath} must be one of: ${enumValues.join(", ")}.`);
    return;
  }

  switch (schema.type) {
    case "object":
      validateObject(schema, value, valuePath, errors);
      return;
    case "array":
      validateArray(schema, value, valuePath, errors);
      return;
    case "string":
      if (typeof value !== "string") {
        errors.push(`${valuePath} must be a string.`);
      } else {
        if (
          typeof schema.minLength === "number" &&
          value.length < schema.minLength
        ) {
          errors.push(
            `${valuePath} must contain at least ${schema.minLength} characters.`,
          );
        }

        if (
          typeof schema.maxLength === "number" &&
          value.length > schema.maxLength
        ) {
          errors.push(
            `${valuePath} cannot contain more than ${schema.maxLength} characters.`,
          );
        }

        if (typeof schema.pattern === "string") {
          let pattern: RegExp | undefined;

          try {
            pattern = new RegExp(schema.pattern);
          } catch {
            errors.push(`${valuePath} has an invalid schema pattern.`);
          }

          if (pattern && !pattern.test(value)) {
            errors.push(`${valuePath} does not match the required pattern.`);
          }
        }
      }
      return;
    case "number":
      if (typeof value !== "number" || !Number.isFinite(value)) {
        errors.push(`${valuePath} must be a finite number.`);
      }
      return;
    case "boolean":
      if (typeof value !== "boolean") {
        errors.push(`${valuePath} must be a boolean.`);
      }
      return;
    default:
      return;
  }
}

function validateObject(
  schema: Record<string, unknown>,
  value: unknown,
  valuePath: string,
  errors: string[],
): void {
  if (!isRecord(value)) {
    errors.push(`${valuePath} must be an object.`);
    return;
  }

  const required = Array.isArray(schema.required)
    ? schema.required.filter((name): name is string => typeof name === "string")
    : [];

  for (const name of required) {
    if (!Object.hasOwn(value, name)) {
      errors.push(`${valuePath}.${name} is required.`);
    }
  }

  if (!isRecord(schema.properties)) {
    return;
  }

  for (const [name, propertySchema] of Object.entries(schema.properties)) {
    if (!Object.hasOwn(value, name) || !isRecord(propertySchema)) {
      continue;
    }

    validateValue(propertySchema, value[name], `${valuePath}.${name}`, errors);
  }

  if (schema.additionalProperties === false) {
    for (const name of Object.keys(value)) {
      if (!Object.hasOwn(schema.properties, name)) {
        errors.push(`${valuePath}.${name} is not allowed.`);
      }
    }
  }
}

function validateArray(
  schema: Record<string, unknown>,
  value: unknown,
  valuePath: string,
  errors: string[],
): void {
  if (!Array.isArray(value)) {
    errors.push(`${valuePath} must be an array.`);
    return;
  }

  if (
    typeof schema.maxItems === "number" &&
    value.length > schema.maxItems
  ) {
    errors.push(`${valuePath} cannot contain more than ${schema.maxItems} items.`);
  }

  if (!isRecord(schema.items)) {
    return;
  }

  value.forEach((item, index) => {
    validateValue(
      schema.items as Record<string, unknown>,
      item,
      `${valuePath}[${index}]`,
      errors,
    );
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
