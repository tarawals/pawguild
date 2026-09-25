# PAWGUILD — MASTER BUILD INSTRUCTIONS

> This is the governing instruction set for all PawGuild development.
> Every engineering session (human or Claude Code) should read this first.

## 1. PROJECT IDENTITY

**Product name:** PawGuild
**Brand spelling:** `PawGuild` — always one word, capital P and G.

PawGuild is a serious B2B SaaS platform for pet-care businesses. It is designed to serve businesses such as:

- Dog daycare
- Pet boarding
- Grooming businesses
- Pet resorts
- Multi-service pet-care facilities
- Businesses operating multiple locations

PawGuild is an operational management platform, not a consumer pet app.

### IMPORTANT NAMING RULE

The previous project name was Pawstead.
Do NOT use “Pawstead” anywhere in new project materials.
Replace it with PawGuild in:

- Application UI
- Page titles
- README files
- Documentation
- Database seed data
- Demo data
- Marketing copy
- Metadata
- Repository documentation
- Comments where the old product name would otherwise appear
- Generated assets
- App name
- Website name
- Configuration where appropriate

If an old reference to Pawstead is discovered, update it to PawGuild unless there is a specific historical reason that the old name must be retained.

## 2. PRODUCT VISION

PawGuild should become the central operating system for a professional pet-care business.
The product should help a business manage:

- Customers
- Pets
- Reservations
- Daycare
- Boarding
- Grooming
- Check-in/check-out
- Feeding
- Medication
- Daily activities
- Incidents
- Kennels/rooms/resources
- Employees
- Scheduling
- Services
- Pricing
- Packages
- Memberships
- Invoices
- Payments
- Credits
- Deposits
- Reports
- Notifications
- Business settings
- Multiple locations
- Permissions
- Audit history

The product should feel like a legitimate commercial SaaS application rather than a prototype.
Prioritize:

1. Reliability
2. Data integrity
3. Usability
4. Clear workflows
5. Maintainability
6. Security
7. Scalability
8. Professional visual design

Do not build features merely because they are technically interesting. Build the systems needed to support real pet-care operations.

## 3. CURRENT PRODUCT SCOPE

The current phase is focused on internal business operations.

### IN SCOPE

Staff/business users should be able to:

- View the operational dashboard
- Manage customers
- Manage pets
- Manage reservations
- Manage daycare stays
- Manage boarding stays
- Manage grooming appointments
- Check pets in
- Check pets out
- Record feeding
- Record medication
- Record activities
- Record incidents
- Manage kennel/room/resource assignments
- Manage capacity
- Manage services
- Manage pricing
- Manage employees
- Manage schedules
- Manage invoices
- Record payments
- Issue refunds/credits where appropriate
- View balances
- Generate operational reports
- Manage locations
- Manage business settings
- Manage staff permissions
- Review audit history
- Receive internal operational notifications

### CURRENTLY OUT OF SCOPE

Do NOT prioritize or build a full customer-facing ecosystem yet.
Specifically, do not treat these as current MVP requirements:

- Customer login
- Customer self-service portal
- Customer mobile application
- Customer self-service booking
- Customer self-service payment
- Public customer dashboards
- Public marketplace
- Social features
- Consumer pet-health tracking
- Consumer pet community

The architecture should leave room for these later, but they should not drive the current implementation.

## 4. TARGET USER

The primary user is a pet-care business employee.
Potential roles include:

- Owner
- Administrator
- General Manager
- Manager
- Front Desk
- Shift Lead
- Groomer
- Care Attendant
- Employee
- Location Manager

Different users should eventually have different permissions.
Use role-based access control rather than scattering hard-coded permission checks throughout the application.

## 5. CORE DATA MODEL

The system should be designed around a relational database.
The conceptual model should include entities such as:

### Organization / Tenant

A business using PawGuild.
Important concepts:

- Organization ID
- Name
- Contact information
- Settings
- Subscription information eventually
- Created/updated timestamps

### Locations

An organization may operate multiple physical locations.
A location should have:

- Organization ID
- Name
- Address
- Contact information
- Business hours
- Holiday/closure settings
- Capacity configuration
- Active/inactive state

### Customers

Customers/owners should belong to an organization.
Store appropriate information such as:

- Name
- Contact information
- Address
- Notes
- Account status
- Balance
- Communication preferences
- Created/updated timestamps

### Pets

Pets belong to customers and organizations.
Potential fields:

- Name
- Species
- Breed
- Sex
- Date of birth/approximate age
- Weight
- Color
- Photo
- Temperament
- Behavioral notes
- Medical notes
- Allergies
- Vaccination records
- Medication information
- Feeding instructions
- Special instructions
- Emergency information
- Status

Do not unnecessarily duplicate customer information on the pet record.

### Reservations

Reservations should support:

- Customer
- Pet(s)
- Location
- Service
- Start date/time
- End date/time
- Status
- Assigned resources
- Notes
- Pricing
- Payment/billing relationships

Support multi-pet reservations where appropriate.

### Services

Services should be configurable.
Examples:

- Daycare
- Boarding
- Grooming
- Bath
- Nail trim
- Training
- Add-ons

Do not hard-code every service into the application.

### Resources

Resources may include:

- Kennels
- Rooms
- Runs
- Play areas
- Grooming stations
- Other capacity-controlled resources

The architecture should support resource assignment and availability.

### Employees

Employees should belong to an organization and optionally one or more locations.
Include:

- Name
- Contact information
- Role
- Status
- Location assignments
- Scheduling information
- Permissions

### Care Records

Care records should capture operational activity.
Examples:

- Feeding
- Medication
- Potty breaks
- Walks
- Play
- Rest
- Grooming
- Notes
- Incidents

These should be associated with the appropriate pet/reservation/date/time/user.

### Financial Records

Support concepts including:

- Invoices
- Invoice line items
- Payments
- Refunds
- Credits
- Deposits
- Balances
- Discounts
- Packages
- Memberships

Maintain an auditable financial history.

## 6. MULTI-TENANCY

PawGuild is intended to become a commercial SaaS.
Design the application so organizations cannot access another organization's data.
Every organization-owned record should have an appropriate tenant relationship.
Do not rely solely on frontend filtering for tenant isolation.
Tenant boundaries should be enforced at the server/database/application authorization layers.
Always consider:

> "Can Organization A accidentally access Organization B's data?"

If the answer could be yes, stop and fix the architecture before continuing.

## 7. DASHBOARD

The dashboard should function as an operational command center.
It should provide useful information such as:

- Today's check-ins
- Today's check-outs
- Dogs currently checked in
- Daycare capacity
- Boarding occupancy
- Upcoming reservations
- Grooming schedule
- Medication due
- Feeding tasks
- Alerts
- Incidents
- Outstanding balances
- Staff tasks
- Operational issues

Avoid turning the dashboard into a collection of decorative charts.
Information should help staff answer:

> What needs my attention right now?

## 8. RESERVATIONS

Reservations are a major system.
Support:

- Daycare reservations
- Boarding reservations
- Grooming appointments
- Multiple pets
- Recurring reservations eventually
- Waitlists
- Availability
- Capacity limits
- Resource assignment
- Business hours
- Holidays/closures
- Cancellation
- Rescheduling
- Status tracking

Reservation states should be explicit.
For example:

- Pending
- Confirmed
- Checked In
- Completed
- Cancelled
- No Show

Do not allow invalid state transitions.

## 9. CAPACITY & RESOURCE MANAGEMENT

Capacity is a business rule, not merely a visual number.
The system should eventually be capable of answering:

- How many dogs can this location accommodate?
- How many boarding spaces are occupied?
- Which resources are available?
- Is a new reservation allowed?
- Which kennel/room is assigned?
- What happens when capacity is reached?

Avoid simplistic frontend-only counters.
Capacity calculations should use actual reservations/resource assignments and defined business rules.

## 10. CHECK-IN / CHECK-OUT

Check-in should be a fast operational workflow.
Staff should be able to:

1. Find reservation
2. Confirm customer/pet
3. Verify relevant requirements
4. Confirm service
5. Assign appropriate resources if necessary
6. Record check-in
7. Surface important alerts/instructions

Check-out should similarly:

1. Identify reservation
2. Confirm pet
3. Review required care/charges
4. Complete required records
5. Record check-out
6. Update reservation state
7. Trigger appropriate billing/accounting behavior

Do not make staff navigate through excessive screens for common operational tasks.

## 11. PET CARE

Pet care records are central to PawGuild.
Staff should be able to record:

### Feeding

- Time
- Food
- Amount
- Instructions
- Completion
- Staff member
- Notes

### Medication

- Medication
- Dosage
- Administration time
- Instructions
- Staff member
- Completion
- Notes

Medication records should be especially auditable.

### Activities

Examples:

- Walk
- Play
- Potty
- Rest
- Group play
- Individual play
- Training

### Incidents

Capture:

- Pet
- Date/time
- Staff member
- Description
- Severity/category
- Actions taken
- Follow-up
- Related reservation

Do not silently overwrite historical care records.

## 12. GROOMING

Grooming should have its own workflow while remaining integrated with customers, pets, reservations, employees, and billing.
Support concepts such as:

- Grooming appointments
- Groomer assignment
- Service type
- Add-ons
- Notes
- Before/after status
- Grooming history
- Pricing
- Completion
- Customer/pet relationship

## 13. BILLING

Billing should be designed carefully.
Support:

- Invoices
- Line items
- Taxes where applicable
- Discounts
- Deposits
- Payments
- Refunds
- Credits
- Outstanding balances

Money should never be represented using floating-point arithmetic where precision matters.
Use appropriate monetary representations.
Financial records should be immutable/auditable wherever practical.
Do not destroy financial history merely because a transaction is corrected.

## 14. REPORTING

Reports should eventually include useful operational information.
Examples:

- Revenue
- Reservations
- Occupancy
- Capacity utilization
- Service utilization
- Customer activity
- Pet activity
- Medication records
- Incident history
- Staff activity
- Outstanding balances

Reports should derive from reliable underlying data rather than maintaining unnecessary duplicate reporting databases during the initial implementation.

## 15. AUDIT LOGGING

Important actions should be auditable.
Examples:

- Customer changes
- Pet changes
- Reservation changes
- Check-in/check-out
- Medication records
- Incident records
- Billing changes
- Permission changes
- Configuration changes

An audit entry should ideally contain:

- Organization
- User
- Action
- Entity type
- Entity ID
- Timestamp
- Relevant before/after information where appropriate

Do not expose sensitive information unnecessarily.

## 16. SECURITY

Treat security as a first-class requirement.
At minimum:

- Authenticate users securely
- Authorize every protected server-side operation
- Enforce tenant isolation
- Validate inputs
- Avoid SQL injection
- Avoid XSS
- Protect sensitive credentials
- Never commit secrets
- Use environment variables for secrets
- Apply least-privilege access
- Validate file uploads
- Avoid exposing internal database details to clients
- Log security-relevant events appropriately

Never put API keys, passwords, tokens, or credentials into source control.

## 17. UI / UX

PawGuild should feel professional and modern.
The interface should prioritize:

- Clear hierarchy
- Fast navigation
- Consistent components
- Readable typography
- Useful tables
- Strong forms
- Clear status indicators
- Helpful empty states
- Useful error messages
- Responsive layouts
- Accessible controls

Avoid:

- Excessive gradients
- Excessive animations
- Giant decorative cards
- Cluttered dashboards
- Tiny text
- Unnecessary modals
- Excessive clicks
- Consumer-app gimmicks

This is business software.
The design should communicate:

> professional + trustworthy + efficient + pet-care-specific

## 18. TECHNICAL ARCHITECTURE

Use a maintainable modern web architecture.
Preferred principles:

- TypeScript
- React-based frontend where appropriate
- Node.js/server-side TypeScript where appropriate
- PostgreSQL
- REST or well-defined typed APIs
- Git/GitHub
- Environment-based configuration
- Automated testing
- Clear separation of concerns

Do not introduce technologies merely because they are fashionable.
Prefer technologies that:

- Have strong documentation
- Are actively maintained
- Are appropriate for SaaS
- Have good TypeScript support
- Can be understood and maintained by a small team

## 19. DATABASE PRINCIPLES

Use a proper relational schema.
Prioritize:

- Foreign keys
- Constraints
- Appropriate indexes
- Unique constraints
- Not-null constraints where appropriate
- Transactions
- Referential integrity
- Explicit relationships

Do not use JSON blobs as a substitute for proper relational modeling when the data needs to be queried, constrained, or related.
Use migrations.
Never make undocumented destructive schema changes.

## 20. API PRINCIPLES

APIs should:

- Validate input
- Authenticate requests
- Authorize requests
- Enforce tenant boundaries
- Return predictable responses
- Return useful error information
- Avoid leaking internal implementation details

Do not trust client-provided organization IDs, user IDs, permissions, or ownership claims.
Derive authorization context from authenticated server-side identity whenever possible.

## 21. TESTING

Testing is required, not optional.
At minimum, test:

### Unit tests

Business logic such as:

- Pricing
- Capacity
- Reservation state transitions
- Availability
- Permissions
- Billing calculations

### Integration tests

Examples:

- API + database
- Authentication
- Reservation creation
- Check-in/check-out
- Billing workflows

### End-to-end tests

Test critical user workflows such as:

1. Create customer
2. Create pet
3. Create reservation
4. Check pet in
5. Record care
6. Check pet out
7. Generate invoice
8. Record payment

Do not consider a feature complete merely because the UI renders.

## 22. GIT / GITHUB

GitHub is the source of truth for the project.
Use meaningful commits.
Do not make enormous commits containing unrelated changes.
Commit after meaningful milestones.
Commit messages should describe what changed.
Before making risky changes:

- Understand current state
- Check git status
- Check recent commits
- Preserve working functionality

Do not overwrite existing work blindly.

## 23. DOCUMENTATION

Maintain durable documentation.
At minimum, maintain:

- README
- Architecture documentation
- Database/schema documentation
- Development setup instructions
- Environment variable documentation
- Feature documentation
- Testing documentation
- Known issues
- Product scope
- Development status
- Important architectural decisions

Documentation should be written for another developer who has never seen the project.
Do not rely on conversation history as the only source of project knowledge.

## 24. CLAUDE CODE WORKFLOW

You are working as an engineering agent.
Before making major changes:

1. Inspect the repository.
2. Understand the existing architecture.
3. Identify relevant files.
4. Check current git status.
5. Read relevant documentation.
6. Determine dependencies.
7. Plan the change.
8. Implement incrementally.
9. Test the change.
10. Review the resulting code.
11. Update documentation.
12. Commit meaningful changes.
13. Push to GitHub when appropriate.

Do not blindly generate an entirely new application if an existing codebase already contains useful work.
Preserve good existing functionality.

## 25. STOP-SAFE / BUDGET PROTOCOL

This project is being developed with a limited Claude Code budget.
Do not burn tokens unnecessarily.
Before beginning a task, determine:

- What must be inspected?
- What can be reused?
- What is the smallest useful implementation?
- What tests are necessary?
- What documentation must change?

Avoid:

- Re-reading the same files repeatedly
- Rewriting working code unnecessarily
- Huge speculative refactors
- Building out-of-scope features
- Gold-plating
- Repeating explanations
- Generating large amounts of code before validating the architecture

If a task becomes unexpectedly large, stop and report:

1. What was discovered
2. What has been completed
3. What remains
4. Why the scope expanded
5. What decision is needed

Do not continue consuming budget simply because a task was started.

## 26. SESSION HANDOFF

At the end of a meaningful development session, provide a concise status report.
Include:

- **Completed** — What was actually implemented.
- **Tested** — What tests/checks were run and their results.
- **Git** — Current branch; commit(s); whether changes were pushed.
- **Remaining** — What is still unfinished.
- **Risks / Issues** — Known technical problems or uncertainties.
- **Next Recommended Step** — The smallest logical next step.

Also update durable project documentation so another Claude Code session can continue without relying on this conversation.

## 27. FEATURE COMPLETION STANDARD

A feature is NOT complete simply because:

- A page exists
- A button exists
- Data can be entered
- The UI looks correct

A feature should be considered complete only when appropriate:

- Data model exists
- API exists
- Authorization exists
- Validation exists
- UI exists
- Error handling exists
- Relevant tests exist
- Database constraints exist
- Tenant isolation is respected
- Documentation is updated

Use judgment based on feature complexity.

## 28. ERROR HANDLING

Errors should be useful to users and developers.
User-facing errors should explain:

- What happened
- What the user can do next

Do not expose:

- Stack traces
- Database internals
- Secrets
- Internal paths
- Sensitive implementation details

Server logs should contain enough information for debugging without unnecessarily logging sensitive personal or financial information.

## 29. ACCESSIBILITY

Build accessibility into the UI.
Pay attention to:

- Keyboard navigation
- Labels
- Focus states
- Semantic HTML
- Contrast
- Form errors
- Screen-reader-friendly controls
- Button names
- Table accessibility

Do not treat accessibility as a final cosmetic pass.

## 30. RESPONSIVENESS

PawGuild should work on:

- Desktop
- Laptop
- Tablet
- Smaller screens where practical

Desktop is particularly important because this is business operations software, but common workflows should not break on smaller screens.

## 31. DATA SAFETY

Never casually delete production-like data.
Prefer:

- Soft deletion where appropriate
- Explicit archival
- Audit trails
- Database constraints
- Confirmation for destructive operations

When deleting records, understand their relationships first.
Do not cascade-delete important historical records accidentally.

## 32. PRODUCT DESIGN PRINCIPLE

When deciding between two implementation approaches, prefer the one that makes the business workflow simpler for staff.

- Would a busy front-desk employee understand what to do here without needing a manual?
- Does this reduce operational work or create more work?
- Will this still make sense when the business has thousands of customers and pets?
- Does the underlying data remain trustworthy?

## 33. IMPORTANT BUSINESS WORKFLOWS

The following workflows deserve particular attention because they represent the core value of PawGuild:

- **Customer → Pet → Reservation** — A staff member should be able to move naturally through: Customer → Pet → Service → Reservation.
- **Reservation → Check-In** — Reservation → Verify → Check In → Resource Assignment → Care.
- **Daily Care** — Pet → Current Stay → Feeding/Medication/Activities/Notes.
- **Check-Out** — Pet → Stay → Care Review → Charges → Check Out.
- **Billing** — Reservation/Services → Invoice → Payment → Balance.
- **Operations** — Dashboard → Alerts → Tasks → Records → Resolution.

## 34. FUTURE ARCHITECTURE

Design with future expansion in mind, but do not build everything now.
Possible future capabilities include:

- Customer portal
- Customer mobile app
- Online booking
- Online payments
- Automated customer notifications
- SMS/email integrations
- Digital waivers
- Online forms
- Advanced reporting
- Marketing automation
- Membership management
- Loyalty programs
- Multi-location enterprise management
- Integrations
- Accounting integrations
- Payment processor integrations
- Public API
- Mobile staff application

The current architecture should avoid making these impossible.
However: future extensibility is not a reason to over-engineer the MVP.

## 35. BRANDING

The product name is: **PawGuild**. Use that exact spelling.

Potential positioning language:

> PawGuild — The operating platform for pet-care businesses.

The brand should feel:

- Professional
- Trustworthy
- Organized
- Modern
- Warm
- Operational
- Pet-specific without feeling childish

Avoid making the brand look like a novelty pet toy, social network, or consumer-only pet app.

## 36. DOMAIN / BRAND STATUS

PawGuild is currently being treated as the working commercial brand.
The name has undergone preliminary web research, but that research is NOT a formal legal trademark clearance.
Do not represent PawGuild as legally trademark-cleared.
Do not claim that the name is guaranteed available.
Before a major public launch, the business should perform appropriate trademark/common-law clearance and consider professional trademark counsel.
The PawGuild.com domain has been identified as a premium domain currently offered for sale.
Do not assume domain ownership is included merely because a domain is available for purchase.

## 37. NO UNAUTHORIZED SCOPE EXPANSION

Do not independently decide to add major features that are not part of the current scope.
If you discover a feature that appears necessary, explain why it is necessary before expanding the scope.
Examples of changes requiring explicit consideration:

- Customer portal
- Mobile customer app
- Online payments
- Public booking
- Marketing automation
- AI features
- Marketplace functionality
- Social/community features
- Large third-party integrations

Small technical improvements required to make an existing feature reliable are acceptable.

## 38. WHEN REQUIREMENTS ARE AMBIGUOUS

Do not guess silently when ambiguity could materially affect:

- Database structure
- Security
- Financial behavior
- User permissions
- Tenant isolation
- Core business workflows
- Data retention
- API contracts

Instead:

1. Identify the ambiguity.
2. Explain the relevant options briefly.
3. Recommend the technically safest interpretation if appropriate.
4. Ask for clarification when the decision materially changes the product.

For low-risk implementation details, use sensible engineering judgment rather than interrupting unnecessarily.

## 39. QUALITY BAR

PawGuild should eventually be capable of being used by a real pet-care business.
Do not optimize for: "It looks like an app."
Optimize for: **"A real business could depend on this."**
That means correctness matters more than flashy features.

## 40. FIRST ACTION

When beginning work in the repository:

1. Confirm the repository and current branch.
2. Inspect the existing project structure.
3. Read existing documentation.
4. Identify the current tech stack.
5. Check git status.
6. Determine what has already been implemented.
7. Do not destroy or replace existing work without understanding it.
8. Create/update the project documentation to identify the product as PawGuild.
9. Establish a clean baseline.
10. Then proceed with the highest-priority unfinished work.

Do not immediately start writing large amounts of code.
Understand first.

## FINAL INSTRUCTION

Treat PawGuild as a real commercial SaaS product from this point forward.

- Build deliberately.
- Protect the data.
- Protect tenant boundaries.
- Test important behavior.
- Document important decisions.
- Keep the code maintainable.
- Respect the defined scope.
- Use Git responsibly.
- Stop when additional work would consume significant budget without clear value.

And above all:

**Build the smallest reliable version of PawGuild that can grow into a serious operating platform for pet-care businesses.**
