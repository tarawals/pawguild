/**
 * Development demo data. Runs as the schema owner. Refuses to run in production.
 * All names are fictional.
 */
import { fileURLToPath } from "node:url";
import { sql } from "kysely";
import { hashPassword } from "../auth/password";
import { createDb } from "./index";

export async function seed(connectionString: string, password: string) {
  const db = createDb(connectionString);
  try {
    const existing = await db.selectFrom("organizations").select("id").where("slug", "=", "harbor-hounds").executeTakeFirst();
    if (existing) {
      console.log("demo organization already exists; skipping seed");
      return;
    }
    await db.transaction().execute(async (trx) => {
      const org = await trx.insertInto("organizations")
        .values({ name: "Harbor Hounds Pet Resort", slug: "harbor-hounds", email: "frontdesk@harborhounds.example", phone: "555-0100", timezone: "America/New_York" })
        .returning("id").executeTakeFirstOrThrow();
      const location = await trx.insertInto("locations")
        .values({ organizationId: org.id, name: "Harbor Hounds — Downtown", city: "Portland", region: "ME", country: "US", taxRateBps: 550 })
        .returning("id").executeTakeFirstOrThrow();
      await trx.insertInto("locationCapacities").values([
        { organizationId: org.id, locationId: location.id, category: "daycare", maxPets: 40 },
        { organizationId: org.id, locationId: location.id, category: "boarding", maxPets: 12 },
      ]).execute();
      // Open 7 AM–7 PM every day; closed on Christmas and New Year's Day.
      await trx.insertInto("locationHours").values([0, 1, 2, 3, 4, 5, 6].map((weekday) => ({
        organizationId: org.id, locationId: location.id, weekday, opensAt: "07:00", closesAt: "19:00",
      }))).execute();
      await trx.insertInto("locationClosures").values([
        { organizationId: org.id, locationId: location.id, closedOn: "2026-12-25", reason: "Christmas Day" },
        { organizationId: org.id, locationId: location.id, closedOn: "2027-01-01", reason: "New Year's Day" },
      ]).execute();
      const kennel = (name: string, kind: string, capacity = 1) => ({ organizationId: org.id, locationId: location.id, name, kind, capacity });
      await trx.insertInto("resources").values([
        ...Array.from({ length: 10 }, (_, i) => kennel(`Kennel ${i + 1}`, "kennel")),
        kennel("Family Suite A", "suite", 3),
        kennel("Grooming Station 1", "grooming_station"),
        kennel("Grooming Station 2", "grooming_station"),
      ]).execute();
      const services = await trx.insertInto("services").values([
        { organizationId: org.id, name: "Daycare — Full Day", category: "daycare", priceCents: 3800, priceUnit: "per_day" },
        { organizationId: org.id, name: "Daycare — Half Day", category: "daycare", priceCents: 2600, priceUnit: "per_day" },
        { organizationId: org.id, name: "Boarding — Standard Suite", category: "boarding", priceCents: 5500, priceUnit: "per_night" },
        { organizationId: org.id, name: "Full Groom", category: "grooming", priceCents: 8500, priceUnit: "per_visit", durationMinutes: 120, isTaxable: true },
        { organizationId: org.id, name: "Bath & Brush", category: "grooming", priceCents: 4000, priceUnit: "per_visit", durationMinutes: 60, isTaxable: true },
        { organizationId: org.id, name: "Nail Trim", category: "add_on", priceCents: 1500, priceUnit: "per_visit", durationMinutes: 15, isTaxable: true },
      ]).returning(["id", "category"]).execute();
      // Typical requirements: daycare/boarding need core vaccines plus Bordetella; grooming needs Rabies.
      const requirement = (serviceId: string, species: string, vaccine: string) => ({ organizationId: org.id, serviceId, species, vaccine });
      await trx.insertInto("serviceVaccineRequirements").values(services.flatMap((s) =>
        s.category === "daycare" || s.category === "boarding"
          ? [requirement(s.id, "dog", "Rabies"), requirement(s.id, "dog", "DHPP"), requirement(s.id, "dog", "Bordetella"),
             requirement(s.id, "cat", "Rabies"), requirement(s.id, "cat", "FVRCP")]
          : s.category === "grooming" ? [requirement(s.id, "dog", "Rabies"), requirement(s.id, "cat", "Rabies")] : [],
      )).execute();
      const passwordHash = await hashPassword(password);
      const staff = [
        { email: "owner@harborhounds.example", firstName: "Jordan", lastName: "Reyes", role: "owner" },
        { email: "desk@harborhounds.example", firstName: "Sam", lastName: "Patel", role: "front_desk" },
        { email: "care@harborhounds.example", firstName: "Alex", lastName: "Kim", role: "care_attendant" },
      ];
      for (const s of staff) {
        const user = await trx.insertInto("users")
          .values({ email: s.email, firstName: s.firstName, lastName: s.lastName, passwordHash })
          .returning("id").executeTakeFirstOrThrow();
        await trx.insertInto("memberships").values({ organizationId: org.id, userId: user.id, role: s.role }).execute();
      }
      const customers = [
        { firstName: "Morgan", lastName: "Ellis", email: "morgan.ellis@example.com", phone: "555-0142", pets: [
          { name: "Biscuit", species: "dog", breed: "Golden Retriever", sex: "male", weightGrams: 31000, feedingInstructions: "1.5 cups kibble twice daily" },
          { name: "Pepper", species: "dog", breed: "Border Collie", sex: "female", weightGrams: 18000, allergies: "Chicken" },
        ] },
        { firstName: "Riley", lastName: "Nguyen", email: "riley.nguyen@example.com", phone: "555-0178", pets: [
          { name: "Juniper", species: "dog", breed: "French Bulldog", sex: "female", weightGrams: 11000, medicalNotes: "Brachycephalic — limit play in heat" },
        ] },
        { firstName: "Casey", lastName: "Brooks", email: "casey.brooks@example.com", phone: "555-0113", pets: [
          { name: "Otis", species: "dog", breed: "Labrador Mix", sex: "male", weightGrams: 27000, temperament: "Friendly, high energy" },
        ] },
      ];
      const owner = await trx.selectFrom("users").select("id").where("email", "=", "owner@harborhounds.example").executeTakeFirstOrThrow();
      for (const { pets, ...c } of customers) {
        const customer = await trx.insertInto("customers").values({ ...c, organizationId: org.id }).returning("id").executeTakeFirstOrThrow();
        for (const pet of pets) {
          const p = await trx.insertInto("pets").values({ ...pet, organizationId: org.id, customerId: customer.id }).returning("id").executeTakeFirstOrThrow();
          const soon = new Date(Date.now() + (pet.name === "Otis" ? 10 : 200) * 86400_000).toISOString().slice(0, 10);
          if (pet.name === "Juniper") {
            await trx.insertInto("petMedications").values({
              organizationId: org.id, petId: p.id, name: "Ofloxacin eye drops", dosage: "1 drop each eye",
              instructions: "Hold head gently; reward after.", times: sql`'{08:00,20:00}'::time[]` as unknown as string[],
              createdByUserId: owner.id,
            }).execute();
          }
          // Otis is deliberately missing DHPP so the demo shows check-in verification.
          await trx.insertInto("petVaccinations").values([
            { organizationId: org.id, petId: p.id, vaccine: "Rabies", expiresOn: soon, recordedByUserId: owner.id },
            { organizationId: org.id, petId: p.id, vaccine: "Bordetella", expiresOn: soon, recordedByUserId: owner.id },
            ...(pet.name === "Otis" ? [] : [{ organizationId: org.id, petId: p.id, vaccine: "DHPP", expiresOn: soon, recordedByUserId: owner.id }]),
          ]).execute();
        }
      }
    });
    console.log("seeded demo organization 'Harbor Hounds Pet Resort'");
    console.log("sign in as owner@harborhounds.example / desk@… / care@… with SEED_PASSWORD");
  } finally {
    await db.destroy();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.env.NODE_ENV === "production") throw new Error("Refusing to seed demo data in production");
  const url = process.env.MIGRATION_DATABASE_URL;
  const password = process.env.SEED_PASSWORD;
  if (!url || !password) throw new Error("MIGRATION_DATABASE_URL and SEED_PASSWORD are required");
  await seed(url, password);
}
