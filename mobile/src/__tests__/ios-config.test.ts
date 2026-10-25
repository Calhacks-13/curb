import appConfig from "../../app.json";

describe("iOS development networking", () => {
  it("explains why the app needs local-network access for Metro and a local API", () => {
    expect(appConfig.expo.ios.infoPlist.NSLocalNetworkUsageDescription).toMatch(
      /development server.*local API/i,
    );
  });
});
