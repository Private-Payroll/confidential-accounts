/*
 * The person signed in, as the service's sign-in check puts it on each request it lets through: `userId` is the
 * person's id, and a route that reads it trusts that check alone. It is a file of its own so that each route reading
 * `userId` imports it and carries it wherever that route is compiled, by the service itself or by a test that runs the
 * route without the rest of the service.
 */
declare global { namespace Express { interface Request { userId?: string } } }

export {};
