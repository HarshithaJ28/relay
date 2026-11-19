describe("event types, subscriptions, API keys and roles", () => {
  let owner: { email: string; password: string };
  beforeEach(() =>
    cy.task("tenant").then((t) => {
      owner = t as typeof owner;
      cy.signIn(owner.email, owner.password);
    }),
  );

  it("adds an event type and subscribes an endpoint to it", () => {
    cy.visit("/event-types");
    cy.findLabel("New event type").type("order.paid");
    cy.contains("button", /^Add$/).click();
    cy.contains("td", "order.paid").should("be.visible");
    // The same name again is refused on the field.
    cy.findLabel("New event type").type("order.paid");
    cy.contains("button", /^Add$/).click();
    cy.findLabel("New event type").should("have.attr", "aria-invalid", "true");

    cy.visit("/endpoints");
    cy.contains("button", "Add endpoint").click();
    cy.findLabel("URL").type("http://127.0.0.1:9/hooks/orders");
    cy.get('[role="dialog"]').contains("button", "Add endpoint").click();
    cy.contains("button", "I have saved it").click();

    cy.visit("/subscriptions");
    cy.findLabel("Event type").select("order.paid");
    cy.findLabel("Endpoint").select("http://127.0.0.1:9/hooks/orders");
    cy.contains("button", "Subscribe").click();
    cy.contains("tr", "order.paid").should("contain", "http://127.0.0.1:9/hooks/orders");
  });

  it("shows a new API key once and keeps only its prefix", () => {
    cy.visit("/api-keys");
    cy.contains("button", "Create key").click();
    cy.findLabel("Name (optional)").type("e2e backend");
    cy.get('[role="dialog"]').contains("button", "Create key").click();
    cy.get('[role="dialog"]')
      .find("code")
      .invoke("text")
      .then((key) => {
        expect(key).to.match(/^rly_/);
        cy.contains("button", "I have saved it").click();
        cy.contains("td", "e2e backend").should("be.visible");
        cy.contains(key).should("not.exist");
        cy.reload();
        cy.contains("td", "e2e backend").should("be.visible");
        cy.contains(key).should("not.exist");
      });
  });

  it("gives a viewer a read-only console", () => {
    const viewer = `viewer-${Date.now()}@example.com`;
    const password = "viewer password long enough";
    cy.visit("/users");
    cy.contains("button", "Add user").click();
    cy.findLabel("Email").type(viewer);
    cy.findLabel("Password").type(password);
    cy.findLabel("Role").select("viewer");
    cy.get('[role="dialog"]').contains("button", "Add user").click();
    cy.contains("td", viewer).should("be.visible");

    cy.get('[aria-label="Sign out"]').click();
    cy.signIn(viewer, password);
    cy.visit("/endpoints");
    cy.contains("h1", "Endpoints").should("be.visible");
    cy.contains("button", "Add endpoint").should("not.exist");
    cy.visit("/users");
    cy.contains("This page needs the").should("be.visible");
    cy.contains("button", "Add user").should("not.exist");
  });
});
