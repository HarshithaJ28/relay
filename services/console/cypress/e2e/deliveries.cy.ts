// Nothing listens on port 9 and no worker runs: deliveries stay scheduled until a test
// finishes one, so these flows check the console and control plane, not sending.
const HOOK = "http://127.0.0.1:9/hooks/e2e";

describe("endpoints, deliveries and replay", () => {
  beforeEach(() =>
    cy
      .task("tenant")
      .then((t) => cy.signIn((t as { email: string }).email, (t as { password: string }).password)),
  );

  it("adds an endpoint, shows its secret once, and sends a test event", () => {
    cy.visit("/endpoints");
    cy.contains("button", "Add endpoint").click();
    cy.findLabel("URL").type(HOOK);
    cy.get('[role="dialog"]').contains("button", "Add endpoint").click();
    cy.get('[role="dialog"]')
      .find("code")
      .invoke("text")
      .should("match", /^whsec_/);
    cy.contains("button", "I have saved it").click();
    cy.get('[role="dialog"]').should("not.exist");
    cy.contains("td", HOOK).should("be.visible");
    // The secret is not on the page any more.
    cy.contains("whsec_").should("not.exist");

    cy.contains("button", "Send test").click();
    cy.contains("Test event sent").should("be.visible");
    cy.visit("/deliveries");
    cy.contains("tr", HOOK).should("contain", "Scheduled");
  });

  it("replays a dead delivery into a new one that points back to it", () => {
    cy.visit("/endpoints");
    cy.contains("button", "Add endpoint").click();
    cy.findLabel("URL").type(HOOK);
    cy.get('[role="dialog"]').contains("button", "Add endpoint").click();
    cy.contains("button", "I have saved it").click();
    cy.contains("button", "Send test").click();
    cy.contains("Test event sent").should("be.visible");

    cy.visit("/deliveries");
    cy.get('a[href^="/deliveries/"]').first().click();
    cy.location("pathname")
      .should("match", /^\/deliveries\/[0-9a-f-]{36}$/)
      .then((path) => {
        const original = path.split("/").pop() as string;
        // A scheduled delivery cannot be replayed yet.
        cy.contains("button", "Replay").should("not.exist");
        cy.task("finishDelivery", original);
        cy.reload();
        cy.contains("h1", "Delivery").should("contain", "Failed");
        cy.contains("button", "Replay").click();
        cy.get('[role="dialog"]').contains("button", "Replay").click();
        cy.contains("Replay scheduled").should("be.visible");
        cy.contains("a", "Open the new delivery").click();
        cy.location("pathname").should("not.contain", original);
        cy.contains("dt", "Replay of").next().should("contain", original);
      });
  });
});
