# Product scope — current phase

Source of truth: `Master-Instructions.md` §3, §34 and §37. This is a summary.

**Current phase: internal staff operations.** The users are pet-care business employees.

In scope: dashboard, customers, pets, reservations (daycare, boarding, grooming), check-in and
check-out, feeding, medication, activities and incidents, resources and capacity, services and
pricing, employees and schedules, invoices, payments, refunds and credits, balances, reports,
locations, settings, permissions, audit history, and internal notifications.

Out of scope for now: customer login or portal, customer mobile app, self-service booking or
payment, public dashboards, marketplace, social or community features, and consumer pet-health
tracking. Online payments, marketing automation, AI features and large integrations need explicit
approval before any work starts.

The architecture leaves room for a customer portal later. `users` is staff identity only, so
customers would get a separate identity model.
