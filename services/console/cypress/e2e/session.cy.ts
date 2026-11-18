describe("session", () => {
  let owner: { email: string; password: string };
  before(() => cy.task("tenant").then((t) => (owner = t as typeof owner)));

  it("signs in, keeps the session across a reload, and signs out", () => {
    cy.signIn(owner.email, owner.password);
    // The access token lives in memory only: a reload must come back through the refresh
    // cookie, which works only because /api is on the console's own origin.
    cy.reload();
    cy.contains("h1", "Overview").should("be.visible");
    cy.contains(owner.email).should("be.visible");
    cy.get('[aria-label="Sign out"]').click();
    cy.location("pathname").should("eq", "/login");
    cy.visit("/endpoints");
    cy.location("pathname").should("eq", "/login");
  });

  it("rejects a wrong password without signing in", () => {
    cy.visit("/login");
    cy.findLabel("Email").type(owner.email);
    cy.findLabel("Password").type("not the password at all");
    cy.contains("button", "Sign in").click();
    cy.get('[role="alert"]').should("be.visible");
    cy.location("pathname").should("eq", "/login");
  });
});
