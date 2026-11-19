declare global {
  namespace Cypress {
    interface Chainable {
      /** Signs in through the login form and waits for the overview. */
      signIn(email: string, password: string): Chainable<void>;
    }
  }
}

Cypress.Commands.add("signIn", (email: string, password: string) => {
  cy.visit("/login");
  cy.findLabel("Email").type(email);
  cy.findLabel("Password").type(password, { log: false });
  cy.contains("button", "Sign in").click();
  cy.location("pathname").should("eq", "/");
  cy.contains("h1", "Overview").should("be.visible");
});

declare global {
  namespace Cypress {
    interface Chainable {
      /** The form control a visible <label> names. */
      findLabel(text: string): Chainable<JQuery<HTMLElement>>;
    }
  }
}

Cypress.Commands.add("findLabel", (text: string) =>
  cy
    .contains("label", new RegExp(`^${text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`))
    .invoke("attr", "for")
    .then((id) => cy.get(`[id="${id}"]`)),
);

export {};
